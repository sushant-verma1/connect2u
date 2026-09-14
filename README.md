# otp-router

A provider-independent OTP verification router with automatic cross-channel fallback.

A company integrates two REST endpoints — `POST /v1/verification/start`,
`POST /v1/verification/check`. Underneath, the router picks the channel most likely to
actually get a code into the user's hands (not just delivered — verified), falls back to
another channel automatically when it doesn't, and learns per-number which channel works
from every attempt it makes. It sits above providers rather than being one: WhatsApp
direct to Meta at Meta's rate, Indian SMS through a domestic provider, international SMS
through Twilio, all behind one contract that never changes for the customer.

What's actually differentiated from "WhatsApp-first with SMS fallback" (Twilio Verify
already does that): outcome-scored routing rather than an if-else chain, a decision log
that explains every skip rather than a black box, and a routing policy an account can
edit through the API with no deploy. See `PROJECT.md` for the full framing,
`ARCHITECTURE.md` for system structure, and `REQUIREMENTS.md` for what's actually tested.

## Architecture

```
                    ┌─────────────────────────────────────────┐
   customer  ──────▶│  apps/api  (Fastify)                    │
   POST /start      │  auth → validate → rate limit → route   │
   POST /check      │  → persist → enqueue → 202               │
                    └──────────────┬──────────────────────────┘
                                   │ enqueue
                          ┌────────▼────────┐
                          │  Redis / BullMQ │
                          └────────┬────────┘
                                   │ consume
                    ┌──────────────▼──────────────────────────┐
                    │  apps/worker                             │
                    │  delivery · fallback-timer ·             │
                    │  webhook-ingest · score-recompute        │
                    └──────┬───────────────────────┬───────────┘
                           │ send                   │ read/write
                    ┌──────▼───────┐        ┌──────▼──────┐
                    │  providers   │        │  Postgres   │
                    │  meta·twilio·│        └─────────────┘
                    │  simulated   │
                    └──────▲───────┘
                           │ status webhooks
                    ┌──────┴──────────────────────┐
                    │  apps/api /webhooks/:prov    │
                    │  verify sig → dedupe → 200   │
                    └──────────────────────────────┘
```

Three processes: **api**, **worker**, and the **dashboard** static bundle. Postgres and
Redis are managed services. The API never calls a provider synchronously — that single
rule is what makes the sub-100ms `/start` response (`R1.1.5`) achievable and testable
(full diagram and package boundaries: `ARCHITECTURE.md` §1–2).

## Fallback timeout reasoning

Every channel in a verification's chain gets a fixed timeout, scheduled the moment that
channel's send is confirmed (`R4.2` — at send time, not at `/start` time, since there's
nothing to time out until a send has actually happened):

| Channel  | Timeout |
| -------- | ------- |
| WhatsApp | 20s     |
| SMS      | 30s     |

**Why these numbers, not something else.** Waiting for a WhatsApp read receipt means
waiting forever — plenty of people leave a chat unread for hours. So the timeout has to
be judged against _when the user acts_, not when they _see_ the message, and most users
who are going to enter a code at all do it within about 15 seconds of it arriving.

That gives a window: below roughly 15s, the fallback fires while a normal, attentive
user is still mid-read — every one of those verifications now gets sent twice, on two
channels, and pays for both. Above roughly 30s, a user who hasn't acted by then has
usually already given up and closed the tab; firing a fallback at that point buys
nothing but cost. 20–30s is the balance point: late enough that a normal user's
in-progress action isn't second-guessed, early enough that a genuinely stuck delivery
gets a second channel before the user abandons the flow. SMS gets the longer end of that
window because carrier-side SMS latency is itself more variable than a WhatsApp Cloud
API send, so a SMS-is-the-fallback path needs more slack before its own timer would fire
in turn.

These are fixed constants for now (`packages/core/src/fallback/channel-chain.ts`,
`CHANNEL_TIMEOUT_MS`) applied identically to every account. `R4.5` calls for this to
come from each account's routing policy instead — Phase 5's job. Until then, every
account gets the same reasoning applied to it, which is at least a defensible default
rather than an arbitrary one.

**What actually enforces this, not just the number.** The timeout value is only half the
story — the other half is that firing it must be safe to get wrong twice:

- **The fallback timer is not the only way a channel resolves.** A `delivered` or
  `delivery-failed` webhook can resolve the same attempt first. Both paths — the webhook
  processor and the timer processor — write through the same atomic conditional UPDATE
  (`WHERE status = 'sent'`), so whichever reaches Postgres first wins the row, and the
  other one's UPDATE matches zero rows. That's the entire mechanism behind "a timer
  firing against a terminal verification is a no-op returning success, not an error"
  (`R4.3`/I9) — there's no separate cancellation state to get out of sync, just one
  guard that every writer already goes through.
- **Cancellation on success is best-effort, deliberately.** When `/check` succeeds, the
  API tries to remove every pending fallback-timer job for that verification
  (`queue.remove(jobId)`). If that removal is missed — a race, a crash, whatever — the
  timer still fires later, hits the same conditional UPDATE, finds the attempt already
  resolved, and no-ops. The correctness guarantee never depends on the cancellation
  actually landing.
- **The code is never regenerated across the chain (`R2.3`).** Every channel in the
  chain sends the exact same code, decrypted from `verifications.code_encrypted`
  (AES-256-GCM, distinct key from every other secret in the system) at the moment a
  fallback advances. This is what makes "late delivery after fallback fired still
  verifies" (T5) true by construction: `/check` only ever looks at the verification row,
  never at which channel's delivery attempt is in what state.

## State machine

Committed to `docs/state-machine.md` before lifecycle code was written, per PLAN.md
Phase 0 — every ambiguity resolved on paper first.

```mermaid
stateDiagram-v2
    [*] --> pending: POST /start

    pending --> verified: correct code
    pending --> expired: TTL elapsed
    pending --> burned: 5th failed attempt
    pending --> failed: all channels exhausted

    verified --> [*]
    expired --> [*]
    burned --> [*]
    failed --> [*]
```

`pending` is the only non-terminal state. Every transition is a single atomic
conditional `UPDATE ... WHERE status = 'pending'`, checked by affected row count — zero
rows means someone else already won the race, and the response is the current state,
never a retry or an error. A late event (a delayed webhook, a fallback timer firing
after success) arriving against a terminal verification is a no-op that returns `200`
(I9). Full rules and rationale: `docs/state-machine.md`.

## Phase 4 — real provider contract and webhooks

Reduced scope per `PROJECT.md`'s hard constraints: a test WABA can't create the
authentication templates a real OTP send needs, so `MetaProvider` is written against the
real Cloud API contract and proven with a live `hello_world` send, but
`SimulatedProvider` remains the primary delivery path (`R5.3`). Twilio, authentication
templates, and production WABA setup are all skipped entirely.

**Signature verification runs before any parsing or database work.**
`POST /v1/webhooks/meta` verifies `X-Hub-Signature-256` inside a Fastify content-type
parser scoped to just that route — it runs on the raw request bytes before Fastify's
JSON parser, Zod validation, or the route handler ever see the body. An invalid
signature calls back with an error carrying `statusCode: 401` and the request never
reaches the handler, the ingest queue, or Postgres (T11). Ordering is the actual
security property here, not just the presence of an HMAC check: verifying a signature
_after_ parsing means an attacker's malformed-but-unsigned JSON has already been
deserialized by the time you reject it.

**Dedupe is a database unique constraint, not application bookkeeping.**
`webhook_events` is keyed on `(provider, provider_message_id)` alone (not event type) —
the first event a message receives is the one stored and acted on; any later event for
that same message, regardless of type, is a duplicate at the DB level (`R6.2`). A late
`delivered` arriving after a `failed` already resolved the attempt (`R4.8`) is the
canonical case this covers.

**Cost is frozen onto the attempt at send time, not looked up later (`G8`).**
`provider_rates` holds Meta's WhatsApp authentication rate card — ₹0.115 India domestic,
₹2.00 international (midpoint of the ₹1.75–2.50 band), effective 1 July 2026 — plus
representative SMS placeholders. `cost_micros_at_send` is written once, at send time,
so a later rate-card update never rewrites a historical attempt's cost. Seed it with
`pnpm --filter @otp-router/api seed:rates`.

**Local webhook delivery.** Meta needs a public HTTPS URL to call back. Run:

```
cloudflared tunnel --url http://localhost:3000
```

and register the printed `https://*.trycloudflare.com/v1/webhooks/meta` URL (plus
`META_WEBHOOK_VERIFY_TOKEN`) in the Meta app dashboard's webhook subscription.

**Live proof.** With `META_PHONE_NUMBER_ID`, `META_ACCESS_TOKEN`, and
`META_APP_SECRET` set, `MetaProvider` sends a real `hello_world` template — the
recorded demo artifact proving the adapter talks to the actual Cloud API, not just its
documented shape.

## Simulation results

`pnpm simulate --scenario=india-mixed --seed=42` drives the **real** routing engine
(`R9.2`) through a seeded synthetic population and virtual clock — no wall-clock
sleeping, no reimplemented routing logic. `--ab` compares outcome-scored routing against
a fixed, non-adaptive channel order on identical traffic. Named presets: `india-mixed`,
`whatsapp-degraded`, `cold-start`; other scenario files under
`packages/simulator/scenarios/` (e.g. `international.yaml`) run by path:
`--scenario=packages/simulator/scenarios/international.yaml`.

**Method.** All numbers below are from `pnpm simulate --scenario=india-mixed --seed=42
--ab [--fixed-chain=<chain>]`, 10,000 simulated verifications, reproducible with that
exact command and seed. Cost is `provider_rates` INR at send time (`G8`); "verified"
means a correct `/check` within TTL, not a delivery webhook (`G1`).

| Metric (india-mixed, seed 42) | Outcome-scored | Fixed whatsapp→sms | Fixed sms-only |
| ----------------------------- | -------------: | -----------------: | -------------: |
| Verification rate             |         93.34% |             92.94% |         88.73% |
| Fallback rate                 |         11.20% |             38.46% |          0.00% |
| p50 time-to-verify            |        7,996ms |            9,289ms |        7,688ms |
| p95 time-to-verify            |       27,539ms |           37,234ms |       23,528ms |
| Cost per verified (₹)         |         0.1708 |             0.1808 |         0.1658 |

Read against the fixed WhatsApp-first chain, outcome-scored routing is **~6% cheaper**
per successful verification and has a **27pp lower fallback rate**, at effectively the
same verification rate (**-0.4pp**, a wash). **That ~6% figure is India-domestic-only** —
it comes from `india-mixed` traffic priced against `provider_rates`' domestic rate card
(₹0.115 WhatsApp vs ₹0.15 SMS) and does not generalize to international corridors, where
the rate ratio between channels is different (`PROJECT.md`'s ₹1.75–2.50 international
WhatsApp band vs a separate SMS rate) and the cost comparison would need its own run to
state, not an assumption that the domestic direction holds. Read against SMS-only,
outcome-scored routing is **4.6pp more successful** but **~3% more expensive** per
success — it spends more because it tries the (here, cheaper) WhatsApp channel first and
sometimes pays for a wasted attempt before falling back, but that spend buys more
completed verifications.

**Model limitation: SMS has no reachability gate.** The synthetic population
(`packages/simulator/src/population.ts`) models WhatsApp reachability explicitly
(`whatsappReachableShare`) but treats SMS as reaching 100% of numbers — the reduced-scope
assumption this project makes about SMS (`PROJECT.md`). That is why routing order barely
moves verification rate against the fixed WhatsApp-first chain above: in this model, SMS
as a fallback essentially never fails to reach someone once tried, so there is no
scenario in which routing order determines whether a verification succeeds at all, only
how fast and how expensively it does. **The cost finding above is conditional on that
assumption**: under this model, pure verification-rate optimization would shift traffic
toward SMS even though it is the more expensive channel here, purely because SMS never
fails to reach a number — a real SMS failure mode (carrier filtering, DND registry
rejection, DLT template mismatches) would very likely make routing order affect
verification rate too, not just cost and speed. That mechanism doesn't exist in this
simulator today; the fix is adding it to the model, not tuning scenario parameters to
manufacture a bigger delta on the model as it stands.

## SDK

`packages/sdk` is a typed client over the two customer-facing endpoints (`G9`):

```ts
import { OtpRouterClient } from "@otp-router/sdk";

const client = new OtpRouterClient({ apiKey: "sk_live_...", baseUrl: "https://api.example.com" });

// Idempotency-Key is auto-generated with crypto.randomUUID() when omitted (R1.1.6) —
// a retried network call replays the original send instead of queuing a second one.
const { verification_id } = await client.start({ phone_number: "+919876543210" });

const result = await client.check({ verification_id, code: "123456" });
// or poll instead of prompting the user for a code synchronously:
const final = await client.waitForResult(verification_id, { intervalMs: 2000, timeoutMs: 60_000 });
```

## Out of scope

Articulated scoping reads as maturity; unexplained gaps read as abandonment.

| Excluded                                   | Reason                                                                                                                                                                                                                                                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ads or promotional content in messages** | Structurally impossible. WhatsApp authentication templates use a preset format with no URLs, media, or emojis, and only authentication templates may carry a passcode. Mixing promotional content risks reclassification of every template on the account. Indian SMS is blocked equivalently by DLT. |
| Voice OTP                                  | A whole telephony surface for one more chart bar                                                                                                                                                                                                                                                      |
| Push channel                               | Requires per-customer mobile SDK integration                                                                                                                                                                                                                                                          |
| Email channel                              | Least interesting adapter, deepest deliverability rabbit hole                                                                                                                                                                                                                                         |
| Billing / payments                         | Track cost, don't collect money                                                                                                                                                                                                                                                                       |
| Template management UI                     | Meta's console does this                                                                                                                                                                                                                                                                              |
| Full read-model dashboard                  | Phase 8 built the single-verification trace view (the screen that demonstrates the system); Overview/Cost/Failures/Providers would need a materialised view (`R10.1`) that doesn't exist yet, so those nav destinations were removed rather than left as dead links                                   |
| Multi-region                               | One region                                                                                                                                                                                                                                                                                            |
| Magic links / passkeys                     | Different product                                                                                                                                                                                                                                                                                     |
| Any LLM anywhere                           | Nothing here needs one; adding one weakens the project                                                                                                                                                                                                                                                |

## Platform constraints (read this before asking "why is WhatsApp simulated?")

**Authentication templates cannot be created on a test WABA.** Meta gates template
creation behind production setup — a registered business, business verification with
documents, a dedicated phone number, and a payment method. None of that is available
here. Consequence: WhatsApp is a **simulated channel** for every demo and every
simulation run. `MetaProvider` is still written against the real Cloud API contract
(signature verification, webhook parsing, send shape), and a live `hello_world` send —
the one template a test WABA can send — is recorded as proof the integration actually
talks to Meta's API, not just its documented shape.

Twilio trial accounts (30-day expiry, template-only sending) and TRAI DLT registration
for real Indian SMS are similarly out of reach for an individual account; SMS also runs
through `SimulatedProvider`. None of this touches the parts of the project that are the
actual point — routing, fallback, race handling, and the simulation harness are exercised
against real Postgres, real Redis, and the real routing engine throughout.

## Running it locally, from a fresh clone

One sequence, in order, verified against a genuinely empty database (`docker compose
down -v` first if you've run this before and want to confirm it from scratch):

```
cp .env.example .env    # fill in the pepper/key values (see comments in the file)

docker compose up -d postgres redis
pnpm install

pnpm --filter @otp-router/db db:migrate      # applies packages/db/migrations
pnpm --filter @otp-router/api seed           # prints a usable API key — save it
pnpm --filter @otp-router/api seed:rates     # provider_rates, needed for cost_micros_at_send

pnpm --filter @otp-router/api dev            # :3000
pnpm --filter @otp-router/worker dev         # :3001 — Bull Board + the outbox below
pnpm --filter @otp-router/dashboard dev      # :5173
```

(`pnpm dev` from the repo root runs api+worker together via `--parallel`, which is fine
once you don't need to watch each one's own terminal output separately; the dashboard
still needs its own `pnpm --filter @otp-router/dashboard dev` either way.)

The `seed`, `seed:rates`, and `db:migrate` scripts all pass `--env-file=../../.env` to
`tsx`, the same way `dev` does — every entry point that runs outside a container reads
config from the same root `.env` file, rather than only the long-running servers doing
so and one-off scripts expecting the shell to already export everything.

**Manual demo, without a real WhatsApp/SMS account.** `SimulatedProvider` never lets the
API or dashboard see a plaintext code (`I4`) — the server hashes and encrypts it
immediately and never logs it. So the question "how do I see the code that was 'sent',
to actually type it into `/check`" needs its own answer, the same way Twilio's and
Meta's own sandboxes give you a way to inspect an outbound test message: the worker's
dev-only Fastify instance (`apps/worker/src/bull-board.ts`, only constructed when
`NODE_ENV=development` — the exact same gate as Bull Board, never present in a
production build) exposes

```
GET http://localhost:3001/dev/outbox?phone_number=%2B919876543210
```

returning every `{ phoneNumber, code, channel, providerMessageId }` `SimulatedProvider`
has actually sent in this process, in memory only. It's an HTTP response body, not a log
line — the code never appears in `pino` output anywhere (`R7.2`'s audit covers exactly
this).

**Straight-through demo (WhatsApp succeeds first try):**

```
curl -X POST http://localhost:3000/v1/verification/start \
  -H "Authorization: Bearer <key from seed>" \
  -H "Content-Type: application/json" \
  -d '{"phone_number":"+919876543210"}'
# → { "verification_id": "ver_...", "channel_attempted": "whatsapp", ... }

curl "http://localhost:3001/dev/outbox?phone_number=%2B919876543210"
# → [{ "phoneNumber": "+919876543210", "code": "123456", "channel": "whatsapp",
#      "providerMessageId": "sim_..." }]

curl -X POST http://localhost:3000/v1/verification/check \
  -H "Authorization: Bearer <key from seed>" \
  -H "Content-Type: application/json" \
  -d '{"verification_id":"ver_...","code":"123456"}'
# → { "status": "verified", ... }
```

**Fallback demo (WhatsApp times out, SMS delivers, then the code verifies).** Left to
itself, `SimulatedProvider` only ever sends — it never emits a delivery webhook the way
a real Meta/Twilio callback would, so a channel it sent on will just sit until its
fallback timer fires (20s for WhatsApp, 30s for SMS) and eventually the whole chain is
exhausted (`failed`). To make a channel actually _deliver_ instead of timing out, you
call `POST /v1/webhooks/simulated` yourself — the same endpoint a real provider's
webhook would hit — using the `providerMessageId` the outbox just gave you for that
attempt:

```
curl -X POST http://localhost:3000/v1/verification/start \
  -H "Authorization: Bearer <key from seed>" -H "Content-Type: application/json" \
  -d '{"phone_number":"+919876543210"}'
# → { "verification_id": "ver_...", "channel_attempted": "whatsapp", ... }

# Wait ~20s for the WhatsApp fallback timer to fire (do nothing — no webhook for this one).
```

Then read the outbox and post the SMS attempt's `delivered` webhook **in one shot** —
not as two commands typed separately. `POST /v1/webhooks/simulated` returning
`{"accepted":true}` means the event was enqueued onto `webhookIngestQueue`, not that the
conditional `UPDATE` has run yet (`R6.4`: verify → dedupe → **200 fast**, process on the
queue after). That gap is normal and correct — it's the same "respond fast, do the real
work async" shape as every other webhook path in this project — but it means the time
between "you have the `providerMessageId`" and "the webhook is actually applied in
Postgres" is real time, not zero. Splitting outbox-read and webhook-post into two
separate manual commands (as earlier revisions of this doc did) adds exactly the kind of
human latency — reading output, copy-pasting an ID, retyping a second curl — that can
burn through the 20s WhatsApp / 30s SMS window before the webhook ever reaches Postgres,
at which point the fallback timer wins the row first and legitimately advances the
chain. One combined command removes that gap:

**bash** (`jq` required):

```bash
MSG_ID=$(curl -s "http://localhost:3001/dev/outbox?phone_number=%2B919876543210" \
  | jq -r '[.[] | select(.channel=="sms")] | last | .providerMessageId')
curl -s -X POST http://localhost:3000/v1/webhooks/simulated \
  -H "Content-Type: application/json" \
  -d "{\"provider_message_id\":\"$MSG_ID\",\"event_type\":\"delivered\"}"
# → { "accepted": true } — the SMS attempt is now "delivered", the verification is
#   still "pending" (delivered ≠ verified — G1), exactly the state to demo /check from.
```

**PowerShell:**

```powershell
$msg = (Invoke-RestMethod "http://localhost:3001/dev/outbox?phone_number=%2B919876543210") |
  Where-Object { $_.channel -eq "sms" } | Select-Object -Last 1
Invoke-RestMethod -Method Post "http://localhost:3000/v1/webhooks/simulated" `
  -ContentType "application/json" `
  -Body (@{ provider_message_id = $msg.providerMessageId; event_type = "delivered" } | ConvertTo-Json)
```

Both forms narrow the outbox to one row before reading `providerMessageId`, and that
part is not optional: `/dev/outbox` returns every message this worker process has sent
since it started, across every verification, so on the unfiltered list
`.providerMessageId` is a whole array — which PowerShell string-interpolates into one
space-joined value. The route only requires a non-empty string (`min(1)`), so that
reaches the server as a plausible-looking ID, gets `{"accepted":true}` like any other
event (`R6.4`), and then matches no delivery attempt: the worker logs `webhook event for
unknown provider_message_id — no-op` and changes nothing (`R6.5`). That is the intended
behaviour, but from the client side it is indistinguishable from a webhook that worked,
so check the worker log if a channel you "delivered" still times out.

```
curl -X POST http://localhost:3000/v1/verification/check \
  -H "Authorization: Bearer <key from seed>" -H "Content-Type: application/json" \
  -d '{"verification_id":"ver_...","code":"123456"}'
# → { "status": "verified", ... }
```

No env var or scenario config turns this on — `POST /v1/webhooks/simulated` (added in
Phase 3/4 for the fallback and dedupe tests, `apps/api/src/routes/webhooks.ts`) is
always there; the manual demo just calls it directly instead of a real provider calling
it. `event_type: "failed"` works the same way if you want to demo a hard provider error
advancing the chain instead of a timeout.

Open `http://localhost:5173/trace/<verification_id>` in the dashboard to see the same
verification's routing decision, attempts, and webhook events end to end — this is
where the WhatsApp `timed_out` / SMS `delivered` split from the fallback demo above is
easiest to actually look at.

## Deploy

`docker compose up -d --build` brings up all four services declared in
`docker-compose.yml` — Postgres, Redis, the API (`apps/api/Dockerfile`), and the worker
(`apps/worker/Dockerfile`) — each running its workspace's TypeScript source directly
through `tsx`, the same as `pnpm dev`, rather than maintaining a second
dist-and-rewritten-import-paths build for a set of internal services that are never
published as packages. Before the first boot against a fresh database:

```
pnpm --filter @otp-router/db db:migrate
pnpm --filter @otp-router/api seed:rates
```

`GET /health` and `GET /ready` (the latter checks live Postgres and Redis connectivity)
are what a platform's health check should point at. The dashboard (`apps/dashboard`) is
a static Vite build (`pnpm --filter @otp-router/dashboard build` → `dist/`) meant for a
static host (e.g. Vercel, Netlify, or an nginx container) pointed at the deployed API's
origin via `VITE_API_URL`; it isn't part of `docker-compose.yml` because it's stateless
and has no dependency on the other three services being colocated.

## Known gaps

**How a verified verification gets attributed to a channel is a convention, not a
measurement.** Every channel in a chain sends the same code (`R2.3`) and nothing observes
which message the user actually read, so `channel_verified` — and therefore
`channel_scores`' per-channel verification rate, `G1`'s metric — is decided by rule: the
last channel that delivered, falling back to the last one sent, or `null` when nothing was
sent. The rule, why it is last-delivered rather than first-attempt, the residual bias it
cannot remove, and the constant-`"whatsapp"` bug that made this metric meaningless for
six phases are all in `docs/findings/channel-attribution.md`.

**A `failed` verification carries no reason code.** `R1.2.6`'s `/check` outcome
vocabulary (`verified`, `invalid_code`, `expired`, `already_verified`,
`attempts_exceeded`, `not_found`, `failed`) covers why a `/check` _call_ was rejected,
but a verification that reaches the terminal `failed` state via chain exhaustion (every
channel timed out or hard-errored, with no `/check` ever attempted) exposes the same
bare `"status": "failed"` as a verification that failed for some other reason — a caller
can't distinguish "every channel we tried couldn't reach this number" from other
terminal-failure paths, or get a per-channel breakdown, from `GET /verification/:id`
alone (that detail exists in `GET /verification/:id/trace`'s `attempts` array, but the
trace endpoint is a debugging/dashboard view, not the integration-facing contract).
Not built — noting it as a gap rather than adding a reason-code field speculatively.

## Resume line

> Built a provider-independent OTP verification router (Node/TS, Postgres, Redis,
> BullMQ) with outcome-scored channel selection and automatic fallback; measured
> **4.6pp higher verification rate** than SMS-only routing and **9.7s lower p95**
> (27.5s vs 37.2s) than a fixed WhatsApp-first fallback chain, across 10,000 simulated
> verifications (seed 42, `india-mixed` scenario — see Simulation results above for
> method, the ~6% domestic-only cost figure, and the model's SMS-reachability caveat).
