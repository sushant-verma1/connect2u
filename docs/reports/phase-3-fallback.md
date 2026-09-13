# Phase 3 — fallback and webhook races

## Summary

Fallback is now a real, race-tested mechanism: a channel that never confirms delivery
within its timeout, or that fails outright (send error or a `delivery-failed` webhook),
advances the verification to the next channel in its chain, reusing the exact same code
(R2.3). A `webhook-ingest` queue and a generic `/v1/webhooks/simulated` endpoint exist
now so the race conditions between webhooks and timers could be tested for real — Phase
4 adds Meta's actual signature verification on top of the same pipeline.

## Data model changes

- `verifications.code_encrypted` (AES-256-GCM, new `CODE_ENCRYPTION_KEY`, distinct from
  `PHONE_ENCRYPTION_KEY` and every HMAC pepper) — the one thing that makes R2.3 possible
  across an async, multi-hop pipeline. The code is generated once in `/start`; a
  fallback delivery decrypts this column rather than regenerating anything.
- `verifications.channel_chain` (jsonb array, capped at `MAX_FALLBACK_CHANNELS = 3`,
  R4.7) — fixed at `/start` time from the request's `channels` field or the default
  `["whatsapp", "sms"]`. Full policy-driven chains are R3/Phase 5; this is the
  Phase-3-scoped placeholder.
- `webhook_events` (new table) — `UNIQUE(provider, provider_message_id, event_type)` is
  the entire R6.2 dedupe mechanism. A duplicate webhook's INSERT fails the constraint;
  the processor treats that as "already handled," not an error. No application-level
  bookkeeping needed.
- `delivery_attempts.provider_message_id` gained a partial unique index — how an inbound
  webhook finds the attempt it's about.

## New queues

| Queue            | Producer                                           | Consumer                          |
| ---------------- | -------------------------------------------------- | --------------------------------- |
| `fallback-timer` | worker (delivery processor, at send time, delayed) | worker (fallback-timer processor) |
| `webhook-ingest` | api (`POST /v1/webhooks/simulated`)                | worker (webhook-ingest processor) |

Both follow the same shape as Phase 2's `delivery`/`delivery-dead-letter` pair: types
live in `packages/core/src/queue/`, queue construction in each app's `queue/queues.ts`.

## The one function every fallback trigger goes through

`apps/worker/src/services/fallback.ts` — `advanceOrFail`. All three R4.4 triggers (hard
provider error, delivery-failed webhook, timeout) call it with nothing but
`{ verificationId, accountId, correlationId }`:

1. Re-read the verification. Not `pending` → no-op (R4.3/I9 — this is what makes a
   duplicate or late-arriving trigger safe rather than something each caller has to
   guard against individually).
2. Look at which channels have delivery attempts already; pick the first channel in
   `channel_chain` not among them (`packages/core/src/fallback/channel-chain.ts`,
   pure, unit-tested).
3. No channel left → atomic conditional UPDATE to `failed` (chain exhausted).
4. Otherwise decrypt the phone and code, insert a new `queued` attempt, enqueue it.

Every attempt-level transition out of `sent` (`delivered`, `failed`, `timed_out`) is the
same atomic-conditional-UPDATE-guarded-on-`status='sent'` shape already established in
Phase 1 for the verification state machine. That single pattern, reused, is what makes
T7 and T8 hold: whichever writer's UPDATE lands first wins the row; every later one
matches zero rows and no-ops.

## Exit gate: T5–T8

All four in `apps/api/test/integration/phase3-fallback.integration.test.ts`, against
real Postgres + Redis + three live BullMQ workers (delivery, fallback-timer,
webhook-ingest):

- **T5** — WhatsApp sends, its fallback timer fires (shortened to 150ms via a
  test-only `channelTimeoutMs` override on the delivery processor — production uses the
  real 20s/30s), SMS is tried. A `delivered` webhook for the _original_ WhatsApp message
  then arrives late: it's a no-op against the now-`timed_out` row, but the user still
  checks in with that same code and verifies. Proves R4.8 and R2.3 together.
- **T6** — the same `delivered` webhook POSTed twice (concurrently, via `Promise.all`)
  produces exactly one `webhook_events` row and one state transition. The unique index
  is the whole test.
- **T7** — a `failed` webhook resolves an attempt and advances the chain; a `delivered`
  webhook for the same message arriving afterward doesn't resurrect it. Terminal state
  is whichever one reached Postgres first, not whichever is "logically" more recent —
  there's no reordering by timestamp, deliberately.
- **T8** — a `delivered` webhook and the fallback timer race for the same attempt; the
  webhook is posted well inside the timeout window, so it wins. The timer still fires
  later (the test waits past the original delay) and confirms it does nothing — no
  second channel gets tried.

## A real bug this surfaced: colons in BullMQ job IDs

`fallbackTimerJobId` originally built job IDs as `` `fallback:${attemptId}` `` so
cancellation could be a plain `queue.remove(jobId)`. Every fallback job add from inside
the delivery processor hung — not slow, genuinely never resolved, confirmed by waiting
15s past a 150ms delay. Isolated repros of the same connection topology (separate
connections per Worker, shared connection for producers, multiple `Queue` objects per
name) all worked fine outside the app, which pointed at something specific to the job ID
itself rather than the connection setup once those were ruled out one at a time.
Renaming the ID scheme to `` `fallback-${attemptId}` `` (hyphen, no colon) fixed it
immediately and reproducibly. Filed as a note here rather than a GitHub issue against
`bullmq`/`ioredis` — not chased further since it's now a closed, understood constraint,
but any future custom BullMQ job ID in this codebase should avoid colons.

## Also fixed while debugging the above: one connection per Worker

`apps/worker/src/index.ts` now gives each of the three Workers (delivery, fallback-timer,
webhook-ingest) its own Redis connection, plus a fourth shared connection for the
`Queues` producer object. This was a genuine, separate correctness issue (not the colon
bug): a `Worker`'s blocking read occupies its entire physical connection until a job
arrives or it times out, so sharing one connection across multiple idle Workers (or a
Worker and a producer) means an idle Worker's long block can stall unrelated commands
queued behind it on that socket. This matches BullMQ's own deployment guidance and is
now the standard pattern for every worker-side connection in this codebase, not just the
ones touched by these tests.

## Deliberately not built

- **No chaos-generation helper in `SimulatedProvider`** (PLAN.md's "SimulatedProvider
  v2: out-of-order webhooks, duplicates, late deliveries"). T5–T8 construct and POST the
  exact webhook sequences each race needs directly in the test — building a generic
  configurable chaos generator now, with no consumer besides these four tests, is
  exactly the kind of thing Phase 6's simulator will actually need broadly (many
  scenarios, seeded reproducibility). Building it early for four hand-written tests
  would be scope creep against a requirement (R9) that doesn't exist yet.
- **No real webhook signature verification.** `/v1/webhooks/simulated` has no signature
  scheme because `SimulatedProvider` doesn't have one. Phase 4 adds
  `/v1/webhooks/meta` with `X-Hub-Signature-256` verification (R6.1) on the same
  underlying `webhook-ingest` pipeline — dedupe, attempt lookup, and the fallback
  trigger are already provider-agnostic.
