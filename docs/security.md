# Security

Phase 7 exit gate: brute force, enumeration, replay, toll fraud, and webhook spoofing —
each with the mitigation actually implemented, not an aspiration. Requirement IDs refer
to `REQUIREMENTS.md`.

## Brute force

**Threat:** guessing a verification code (6 digits by default — 1,000,000 possibilities)
or an API key.

- **Code guessing.** Capped at 5 attempts per verification (`R2.6`); the 6th failure
  permanently burns the code (`markFailed`/`recordFailedAttempt`,
  `packages/db/src/repositories/verifications.ts`) — no amount of retrying recovers it.
  Comparison is HMAC + `crypto.timingSafeEqual` (`R1.2.1`), never string equality, so a
  timing side-channel can't narrow the search.
- **Volume.** Sliding-window rate limits, per number/account/IP (`R7.1`/`R1.1.7`,
  `apps/api/src/services/rate-limit.ts`) cap how many verifications can even be started
  against one number, independent of the 5-attempt cap on any single one.
- **API keys.** Hashed at rest with argon2 (`R7.4`, `apps/api/src/crypto/api-key.ts`) —
  a stolen `api_key_hash` row is not a stolen key.

## Enumeration

**Threat:** using `/v1/verification/start` or `/check` responses to learn which phone
numbers exist, are reachable, or belong to which account.

- **No number existence signal.** `/start` always accepts a well-formed E.164 number and
  begins a verification; it never distinguishes "this number doesn't exist" from "this
  number exists but the channel failed" in its response.
- **No cross-account leakage.** Every read is scoped by `account_id` at the query level,
  not filtered after the fact (`R8.1`/`R8.2` — see `findVerificationScoped` and every
  other `find*Scoped` repository function). A verification ID from another account
  returns `404`, identical to a verification ID that never existed.
- **Per-number rate limit doubles as an enumeration brake** (`R7.1`): a script iterating
  through a number range is throttled at 5 starts per number per 10 minutes long before
  it learns anything useful.
- **Prefix velocity** (`R7.6`, `apps/api/src/services/fraud-signals.ts`) catches the
  shape enumeration actually takes — many _different_ numbers in one narrow numbering
  block, hit fast — which a per-number limit alone can't see, since each individual
  number in the range never crosses its own ceiling.

## Replay

**Threat:** an attacker (or a naive retry) resubmits the same `/start` request and
causes a second real-world send, or a captured webhook payload is replayed to force a
state transition.

- **Idempotency-Key** (`R1.1.6`/`T4`, `apps/api/src/services/idempotency.ts`): replaying
  the same key returns the original response verbatim and sends nothing new. Backed by
  a unique index (`verifications_account_idempotency_key_idx`) so two genuinely
  concurrent replays can't both win — the loser's insert hits the constraint and
  re-reads the winner's row instead of double-sending (see the `catch` block in
  `apps/api/src/routes/verification.ts`'s `/start` handler).
- **Webhook dedupe is a database unique constraint, not application bookkeeping**
  (`R6.2`): `webhook_events` is keyed on `(provider, provider_message_id)` alone. A
  replayed webhook payload — the same message ID, captured and resent — is the second
  row Postgres itself rejects; the first event received is the one ever acted on.
- **State transitions are atomic conditional UPDATEs guarded on current status**
  (`R1.2.2`, `I2`, e.g. `markVerified`, `markDeliveryAttemptDelivered`): a replayed
  webhook or a replayed `/check` against an already-resolved row matches zero rows and
  no-ops, rather than re-applying a transition that already happened.

## Toll fraud

**Threat:** an attacker (or a compromised customer integration) drives verification
volume purely to generate provider spend, typically against premium or international
corridors.

- **Daily spend ceiling → `manual_review`, halting further sends** (`R7.5`,
  `apps/worker/src/services/toll-fraud.ts`). Evaluated once per successful send, in its
  own `try`/`catch` isolated from the delivery success/failure path (a fraud-check
  failure must never be mistaken for — or trigger the fallback machinery of — a delivery
  failure, since the send it's evaluating already succeeded). Once tripped,
  `apps/api/src/auth/api-key-auth.ts` rejects the account's subsequent requests with
  `401` as soon as its 30-second auth cache entry expires (the same bounded,
  already-accepted staleness window documented there for key revocation) — this is a
  known, deliberate exposure window, not a silent gap.
  - **Unknown cost is never treated as free.** `cost_micros_at_send` is `NULL` for a
    send through an unpriced corridor (`apps/api/src/routes/verification.ts`'s rate
    lookup already logs this loudly). A ceiling computed as `SUM(cost_micros_at_send)`
    would silently under-count exactly the spend it exists to catch — an unpriced
    corridor is precisely where an attacker would route to stay invisible to it.
    Instead, `packages/core/src/fraud/daily-spend.ts` treats every unpriced send as
    costing `UNPRICED_ATTEMPT_ASSUMED_COST_MICROS` (2,000,000 — the single most
    expensive corridor this rate card knows about, Meta's WhatsApp international rate),
    so the ceiling can only ever over-count unknown-cost sends, never under-count them.
    This is a fixed, conservative placeholder, not a measured number — see the
    `ponytail:` comment on the constant for the intended upgrade path.
- **Prefix velocity limits** (`R7.6`) — see Enumeration above; the same signal that
  catches number-range scanning also catches a fraud pattern where many numbers in one
  block are targeted to run up spend before any single number's own rate limit fires.
- **Country-mix alerting** (`R7.7`, `recordAndCheckCountryMix` in
  `apps/api/src/services/fraud-signals.ts`): a sudden shift toward the
  international corridor for one account is logged, not blocked — a real shift can be a
  legitimate new market, so this is a signal for a human to look at, not an automated
  cutoff.

## Webhook spoofing

**Threat:** a forged webhook payload (a fake "delivered" or "delivery-failed" event)
used to manipulate verification state without ever actually sending anything.

- **Signature verified before any parsing or database work** (`R6.1`,
  `apps/api/src/routes/meta-webhook.ts`): `X-Hub-Signature-256` is checked inside a
  Fastify content-type parser scoped to that route, against the raw request bytes,
  before Fastify's JSON parser or Zod validation ever see the body. An invalid signature
  returns `401` and the request never reaches the handler, the ingest queue, or
  Postgres — ordering is the actual security property, not just the HMAC check's
  presence (verifying _after_ parsing means a malformed-but-unsigned payload has already
  been deserialized by the time it's rejected).
- **Every raw webhook payload is persisted with its `signature_valid` flag** (`R6.6`) —
  an audit trail exists even for rejected attempts.
- **`SimulatedProvider`'s webhook route has no signature scheme to spoof** — there is no
  wire format of its own (see the comment on `verifySignature()` in
  `packages/providers/src/simulated.ts`); this is a deliberately reduced-scope channel,
  not a gap in the real provider's handling.

## Plaintext code exposure

**Threat:** the OTP code appearing somewhere it shouldn't — a log line, an API response,
an inspectable queue payload — at any level, any environment (`R7.2`).

- **Verified by code inspection**: the plaintext code is only ever passed to
  `hmacHex`/`encryptCode` (`apps/api/src/routes/verification.ts`) and the delivery job
  payload (`packages/core/src/queue/delivery-job.ts`); no logger call in either app
  touches it. The dead-letter inspection endpoint (`R4.9`,
  `apps/api/src/routes/dead-letters.ts`) serializes a distinct, narrower
  `DeadLetterRecord` type that has no field to leak the code into, by construction.
- **Verified by test**: `apps/api/test/integration/phase7-security.integration.test.ts`
  runs a full start → deliver → check flow through a real (non-silent, `trace`-level)
  captured logger and asserts the plaintext code `SimulatedProvider` actually sent
  never appears in any captured log line. This is a regression test, not a one-time
  audit — it runs in CI on every change.

### Demo carve-out (I4, AGENTS.md) — retired, not weakened

The public demo used to be `/v1/demo/*`: a real verification under a seeded
`DEMO_ACCOUNT_ID`, with `GET /v1/demo/:id` returning the plaintext code while it was
`pending` — a deliberate, narrow, decided exception to I4. That demo is gone. The
replacement, `/v1/demo/routing/*` (`apps/api/src/routes/demo.ts`, `packages/core/src/demo.ts`
`DEMO_ACCOUNT_ID`), is a pure simulation over a Redis-held session: no verification, no
delivery attempt, no `code_hmac`, no `code_encrypted` — `generateCode`/`encryptCode`
are never called on this path at all. There is no plaintext code for I4 to have an
opinion about, and therefore no carve-out: **I4 now holds for the demo without
exception**, the same as everywhere else in the codebase.

What's still true about `DEMO_ACCOUNT_ID` and still worth stating: it remains a fixed,
seeded, isolated account with no API key, no password, and no linkable Google identity
(`apps/api/src/scripts/seed-demo.ts`) — nothing authenticated can create anything under
it. The demo route group's only database read is that account's active routing policy
(`findActiveRoutingPolicy`, scoped by `account_id` like every other query, I5); it
performs no writes at all. The defence-in-depth guards the old demo needed —
`channel_capability`'s per-account skip in `apps/worker/src/services/capability.ts` and
`channel_scores`'s `account_id <> DEMO_ACCOUNT_ID` exclusion in
`packages/db/src/repositories/channel-scores.ts` — are kept rather than removed, on the
principle that a guard costs nothing to leave in place and a future change to this
route group that started writing under `DEMO_ACCOUNT_ID` again would still be caught by
it.

Verified by test: `apps/api/test/integration/demo-routing.integration.test.ts` asserts
a full 13-attempt session leaves `verifications`, `delivery_attempts`,
`routing_decisions`, and `channel_scores` at zero rows, and separately re-confirms the
`channel_scores` exclusion guard still holds for any row that might exist under
`DEMO_ACCOUNT_ID` regardless of how it got there.

## What's explicitly not covered here

- **API key rotation with an overlap window** (`R7.8`) and **number/prefix blocklists**
  (`R7.9`) are `LATER` in `REQUIREMENTS.md` — not built.
- **A second SMS provider** and **per-provider circuit breakers** (`R5.7`/`R5.8`) are
  also `LATER` — a provider outage today is handled by fallback (Phase 3), not isolation.
