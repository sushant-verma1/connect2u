# Phase 2 — async delivery

## Summary

Delivery moved off the request path entirely. `/start` now does two writes — insert the
verification row, insert a `queued` delivery attempt — enqueues a BullMQ job, and returns
`202`. `apps/worker` is a new, separate process that owns every call to a `Provider`.

## What changed

- **Queue contract** (`packages/core/src/queue/delivery-job.ts`): `DeliveryJobData` and
  `DeadLetterRecord` are pure types shared by producer (`apps/api`) and consumer
  (`apps/worker`), so `packages/core` stays I/O-free while both apps agree on a shape.
- **`apps/api/src/queue/delivery-queue.ts`**: creates the `delivery` queue with
  `attempts: 5` and `backoff: { type: "exponential", delay: 1000, jitter: 0.5 }` —
  BullMQ's built-in jitter, not a hand-rolled one, per TECHSTACK's `Math.random` ban
  (BullMQ's own internals use `Math.random`, which is fine — the ban is on our code).
- **`apps/worker/src/processors/delivery.ts`**: the actual send. Checks
  `delivery_attempts.status` before calling the provider (idempotency, see below), maps
  the caught error through `isPermanentError`/`providerErrorCode`
  (`packages/providers/src/provider.ts`, R5.6), and either lets BullMQ retry (transient)
  or throws `UnrecoverableError` (permanent — never retried) after writing a terminal
  `failed` row and a dead-letter record.
- **Dead-letter queue**: a second BullMQ queue (`delivery-dead-letter`) that nothing
  consumes — jobs just sit in `waiting` as an inspectable list. No new Postgres table:
  BullMQ already persists job data durably in Redis, and TECHSTACK already treats Redis
  as the ephemeral-state store, so reusing a queue as a sanitized inspection list (no
  `code`/`phoneNumber` fields) avoided adding a fourth piece of storage schema for
  something that's fundamentally "recent failures, not a permanent record."
- **`GET /v1/admin/delivery/dead-letters`**: filters the DLQ's jobs by the caller's
  `account_id` before returning them (R8.1), even though the underlying queue is global.
- **Bull Board**: mounted on its own tiny Fastify instance inside `apps/worker`
  (`apps/worker/src/bull-board.ts`), started only when `NODE_ENV=development`, at
  `WORKER_PORT` (default 3001) under `/admin/queues`. Kept out of `apps/api` so the
  worker process stays fully self-contained and the API's route surface stays
  customer-facing only.
- **Correlation IDs**: `request.correlationId` (already threaded per-request in
  `apps/api`) rides along in `DeliveryJobData.correlationId` and is bound into the
  worker's pino child logger, so one ID traces a request from the API through the queue
  into the worker's logs.

## Idempotency: no duplicate send, no lost verification

There's no distributed lock or two-phase commit. The guard is one read at the top of the
processor:

```ts
const existing = await findDeliveryAttempt(pg, attemptId);
if (existing && existing.status !== "queued") return; // already resolved — no-op
```

This is sufficient because `delivery_attempts.status` only ever moves to `sent` or
`failed` _after_ the provider call has fully resolved. If a worker is killed while a send
is in flight, the row is still `queued` when BullMQ's stalled-job recovery redelivers the
job (`lockDuration`/`stalledInterval`) to a new worker — so the resend is not a duplicate
of anything that was ever confirmed, it's the only completed send. The narrow window
between "provider call resolved" and "row written" is an inherent limit of at-least-once
delivery without provider-side idempotency keys (real WhatsApp/SMS providers support
this via a client message ID; `SimulatedProvider` doesn't need to, since nothing external
is actually sent) — accepted as a known ceiling, not solved with a lease/lock system.

Both exit-gate tests live in `apps/api/test/integration/`:

- `phase2-delivery.integration.test.ts` → `/start responds under 100ms even when the
provider takes 5s to answer` (R1.1.5) and `resumes cleanly after the worker is killed
mid-delivery: no duplicate send, no lost verification`. The "kill" is modelled as a
  `send()` call that never resolves, then a force-closed (`worker.close(true)`) BullMQ
  worker with a shortened `lockDuration`/`stalledInterval` so recovery doesn't need a
  real 30s wait — the row-state guard above is what's actually under test, not BullMQ's
  timing.
- A third test in the same file exercises R5.6 directly: a permanent error
  (`invalid_number`) fails on the first attempt, never retries, and lands in the DLQ with
  `attemptsMade: 1`.

## An incidental fix the R1.1.5 test forced — corrected

The first pass at the 100ms test failed at ~150ms with `SimulatedProvider` completely out
of the picture. The cost was `argon2.verify` in `apps/api/src/crypto/api-key.ts`.

**The original fix was wrong and has been reverted.** It lowered argon2's cost
parameters from the defaults (64MB memory, 3 passes, ~40ms/verify) to `memoryCost: 4096,
timeCost: 2` (~5ms/verify) to make the latency test pass. That's weakening the hash to
satisfy a benchmark — the wrong lever, and it contradicts PROJECT.md's own stated
security posture ("Argon2 _is_ correct for API keys," in deliberate contrast to OTP
codes, which use fast HMAC precisely because their 10⁶ search space and 5-attempt burn
make slow hashing pointless). API keys don't get an attempt cap, so weakening their hash
cost is a real, if small, regression — not a wash.

**Actual fix: cache the verification result, not the hash cost.** An API key is a
256-bit random secret, so — as flagged — the _brute-force_ rationale for slow hashing is
weak either way; the real argument for argon2 on API keys is defense against an offline
attack on a leaked hash dump, which has nothing to do with how often a _valid_ key gets
re-verified on the hot path. The two live options were:

1. **In-process cache, keyed on the full key, TTL'd.** Pays argon2's full cost once per
   key per TTL window instead of once per request. Keeps the documented security
   posture completely unchanged.
2. **Switch to HMAC-SHA256 + pepper + `timingSafeEqual`**, mirroring the OTP-code
   reasoning in PROJECT.md.

Went with **(1)**. PROJECT.md treats "argon2 is correct for API keys" as a settled,
deliberate decision with its own stated rationale (a leaked hash is worth attacking,
unlike a 6-digit code) — switching to HMAC would quietly reverse that decision to solve a
performance problem that has nothing to do with which primitive is correct. Caching
solves the actual problem (paying the cost on every request) without touching the
primitive.

Implementation (`apps/api/src/auth/api-key-auth.ts`): a `Map` closed over inside
`createApiKeyAuth`, keyed on the **full key** — not the prefix. The prefix only
identifies which account row to look up; it doesn't prove the secret matched, so caching
on prefix alone would let any request bearing a _correct prefix_ skip verification
regardless of the actual secret. On a hit within `AUTH_CACHE_TTL_MS` (30s), argon2 is
skipped entirely; on a miss, the existing prefix-lookup + `argon2.verify` path runs and
populates the cache on success only. `createApiKeyAuth` is now instantiated once in
`app.ts` and shared across both route groups (verification + dead-letter admin), so the
cache isn't split two ways for no reason.

**Trade-off, stated plainly:** a revoked or suspended API key remains valid for up to 30s
after revocation. Acceptable for this project's scope; the honest alternative (checking
Postgres on every request) is exactly the cost being avoided. If revocation needs to be
immediate, the cache would need active invalidation (e.g. a Redis pub/sub bust on
account suspension) — not built, since nothing in REQUIREMENTS.md asks for that
turnaround.

This also cut the full integration suite's runtime from ~62s to ~9s for the sequential
tests (T2, the two Phase 2 tests) — but T1's 50-concurrent-request rounds still pay full
argon2 cost per round, because all 50 requests race against an empty cache
simultaneously on a fresh `app` instance; the cache only helps repeat traffic, which is
the realistic pattern it's meant for.

## Deliberately not built

- No custom backoff strategy — BullMQ's built-in `exponential` + `jitter` covers it.
- No second Postgres table for the dead-letter queue — see above.
- No lock/lease system for delivery idempotency — the status-check guard is enough given
  `SimulatedProvider`'s all-or-nothing send semantics; revisit if Phase 4's real
  providers need it.
