# PLAN.md

**~4 weeks at 9 focused hours/day.** Phase counts are effort, not calendar.

**Ordering principle:** build what can fail in interesting ways first; build what only looks
good last. That is why the simulator precedes the dashboard, and why fake providers precede
real ones.

---

## Phase 0 — Skeleton (1 day)

1. pnpm monorepo per ARCHITECTURE.md §2.
2. `docker-compose.yml`: Postgres 16, Redis 7.
3. TypeScript `strict`, ESLint, Prettier, Husky.
4. Zod config module — fails at boot on any missing env var (R11.3).
5. Fastify app: `/health`, `/ready`, Pino, correlation-ID middleware.
6. GitHub Actions: typecheck, lint, test.
7. **Commit the state machine diagram** to `docs/` before writing code. Every ambiguity
   resolved on paper saves an hour later.

**Exit:** `docker compose up && pnpm dev` boots, `/health` returns 200, CI green.

---

## Phase 1 — Core lifecycle, one channel, fake provider (3–4 days)

No routing, no fallback, no real provider. Prove correctness first.

1. Drizzle schema: `accounts`, `verifications`, `delivery_attempts`. Migrations committed.
2. Seed script: one account, known API key.
3. API key auth; **every query scoped by `account_id` from the first commit** (R8.1).
4. Code generation via `crypto.randomInt` (R2.1).
5. HMAC-SHA256 + pepper, `timingSafeEqual` (R2.2, R1.2.1).
6. Redis TTL for expiry, Postgres for the record (R2.4).
7. `POST /start` — validate, normalise, generate, persist, dispatch to `SimulatedProvider`
   synchronously for now.
8. `POST /check` — atomic conditional update, attempt counter, 5-attempt burn.
9. `GET /verification/:id`.
10. `SimulatedProvider` v1: fixed latency, configurable failure rate.

**Exit gate — do not pass without these:** T1, T2, T3, T9 from REQUIREMENTS.md §12.

T1 is the one that matters: 50 concurrent `/check` calls with the correct code, exactly one
succeeds, against real Postgres via Testcontainers. Everything built after this assumes it.

---

## Phase 2 — Async delivery (2–3 days)

1. BullMQ; `apps/worker` as a separate process.
2. Move delivery to the `delivery` queue. `/start` now returns `202` immediately.
3. Backoff + jitter on transient errors.
4. Normalised error taxonomy (R5.6). Permanent errors do not retry.
5. Dead-letter queue plus inspection endpoint.
6. Bull Board in dev.
7. Correlation IDs threaded API → job → handler. Add now; you will need it within a day.

**Exit:** `/start` responds under 100ms regardless of simulated provider latency. Killing and
restarting the worker mid-flight resumes cleanly.

---

## Phase 3 — Fallback (3–4 days)

The heart of the product. Slow down here.

1. `fallback-timer` as a BullMQ delayed job, scheduled at send time.
2. Cancellation on success — **idempotent**, it will fire twice (R4.3).
3. Three triggers: hard error, delivery-failed webhook, timeout (R4.4).
4. **One shared code across channels** (R2.3). Never regenerate.
5. Chain cap at N channels.
6. `SimulatedProvider` v2: out-of-order webhooks, duplicates, late deliveries.
7. Write and pass T5, T6, T7, T8.

**Exit gate:** all four race tests pass, and the fallback timeout reasoning is written into
the README while it's fresh.

---

## Phase 4 — Real provider contract and webhooks (2–3 days)

Reduced scope — see PROJECT.md constraints. Authentication templates are unavailable, so this
phase proves the _contract_, not production sending.

1. Formalise the adapter interface; refactor `SimulatedProvider` to implement it (R5.1).
2. `MetaProvider`: Cloud API send, status webhook parsing, `X-Hub-Signature-256` verification.
3. Webhook endpoint: verify signature → dedupe via unique constraint → 200 → queue (R6.1–R6.5).
4. `cloudflared` for local webhook delivery.
5. Verify with a live `hello_world` send. Record it for the demo.
6. Seed `provider_rates` with Meta's authentication rate card (₹0.115 India domestic,
   ₹1.75–2.50 international, effective 1 July 2026) and representative SMS rates. Write
   `cost_micros_at_send` onto every attempt (G8).

**Skip:** Twilio, authentication-template sends, production WABA setup.

**Exit:** T11 passes. A live `hello_world` arrives on a real phone. Rates persist per attempt.

---

## Phase 5 — Routing engine (4–5 days)

Where the project stops being a tutorial.

1. `routing_policies` table: versioned, Zod-validated JSON per account.
2. `GET/PUT /v1/accounts/me/routing-policy`.
3. The four pure functions of ARCHITECTURE.md §5, each unit-tested with plain objects.
4. `channel_capability` keyed on `phone_hash`; confidence decay, success/failure updates.
5. `channel_scores` plus the repeatable `score-recompute` job. **Verification rate, not
   delivery rate** (R3.7).
6. `routing_decisions` — persist every consideration and skip reason (R3.9).

**Exit:** changing an account's policy via API visibly changes the attempted channel, with no
deploy. The decision log explains why.

---

## Phase 6 — Simulation harness (3–4 days)

Highest leverage. Do not skip because the system already "works."

1. YAML scenario format (R9.1).
2. Seeded PRNG threaded through every draw.
3. Virtual clock — no sleeping.
4. Runner driving the **real** engine (R9.2).
5. Report: table plus JSON (R9.5, R9.6).
6. Presets: `india-mixed`, `whatsapp-degraded`, `cold-start`.
7. A/B policy diff mode.
8. Wire into CI so routing regressions fail the build.

**Exit:** T10 passes. Cold-start scenario visibly improves as the capability cache warms.

**This phase produces the resume numbers.** Record them and record how each was measured.

---

## Phase 7 — Hardening (2–3 days)

1. Sliding-window Redis Lua limits: per number, per account, per IP (R7.1).
2. Idempotency keys, 24h (R1.1.6). T4.
3. Toll-fraud protection: daily spend ceiling → `manual_review`, prefix velocity limits,
   country-mix alerting (R7.5–R7.7).
4. API keys hashed with argon2.
5. Audit every log path for plaintext code leakage. Add a test.
6. OpenAPI spec from Zod schemas.

**Exit:** `docs/security.md` covering brute force, enumeration, replay, toll fraud, and
webhook spoofing — with a mitigation for each.

---

## Phase 8 — Dashboard (3 days, hard cap)

1. Read API over a materialised view.
2. React + Vite + TanStack Query + Recharts + shadcn/ui.
3. Screens: overview, cost, failures, providers, and **single-verification trace** (R10.6).

Build the trace view properly. It demonstrates the system rather than decorating it.

**Exit:** you can walk one fallback verification end to end on screen without a terminal.

---

## Phase 9 — Ship (2 days)

1. `packages/sdk` — typed client, polling helper, auto idempotency keys.
2. README: pitch, architecture diagram, fallback-timing reasoning, state machine, simulation
   results with method, out-of-scope list, honest platform-constraint note.
3. 90-second demo recording.
4. Deploy: api, worker, Postgres, Redis.
5. Resume line, filled with measured numbers.

---

## Critical path

**Blocking chain: 1 → 2 → 3 → 5 → 6.** That is the project.

**Safe to cut:** Phase 8 beyond the trace view, SDK publishing, email channel, Twilio
entirely, circuit breakers, outbound webhooks.

**Never cut:** Phase 3 race tests, Phase 5 decision logging, Phase 6 harness. Those three are
the entire difference between this and a queue tutorial.

---

## Weekly shape

| Week | Phases  | You can say                                                                    |
| ---- | ------- | ------------------------------------------------------------------------------ |
| 1    | 0, 1, 2 | "Codes generate, verify, expire, and deliver asynchronously without races."    |
| 2    | 3, 4    | "Fallback fires correctly under every race I could construct."                 |
| 3    | 5, 6    | "Routing is policy-driven, learns from outcomes, and I have measured numbers." |
| 4    | 7, 8, 9 | "Hardened, observable, deployed, documented."                                  |

Behind at the end of week 2? Cut Phase 8 to the trace view and protect Phase 6. The simulator
is worth more than the dashboard, every time.
