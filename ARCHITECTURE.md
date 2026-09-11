# ARCHITECTURE.md

## 1. Shape of the system

```
                    ┌─────────────────────────────────────────┐
   customer  ──────▶│  apps/api  (Fastify)                    │
   POST /start      │  auth → validate → rate limit → route   │
   POST /check      │  → persist → enqueue → 202              │
                    └──────────────┬──────────────────────────┘
                                   │ enqueue
                          ┌────────▼────────┐
                          │  Redis / BullMQ │
                          └────────┬────────┘
                                   │ consume
                    ┌──────────────▼──────────────────────────┐
                    │  apps/worker                            │
                    │  delivery · fallback-timer ·            │
                    │  webhook-ingest · score-recompute       │
                    └──────┬───────────────────────┬──────────┘
                           │ send                  │ read/write
                    ┌──────▼───────┐        ┌──────▼──────┐
                    │  providers   │        │  Postgres   │
                    │  meta·twilio·│        └─────────────┘
                    │  simulated   │
                    └──────▲───────┘
                           │ status webhooks
                    ┌──────┴──────────────────────┐
                    │  apps/api /webhooks/:prov   │
                    │  verify sig → dedupe → 200  │
                    └─────────────────────────────┘
```

Three processes: **api**, **worker**, and the **dashboard** static bundle. Postgres and Redis
are managed services.

The API never calls a provider synchronously. That single rule is what makes R1.1.5 (100ms
response) achievable and what makes the whole thing testable.

---

## 2. Package boundaries

```
otp-router/
├── apps/
│   ├── api/           Fastify — routes, auth, webhook receivers
│   ├── worker/        BullMQ processors
│   └── dashboard/     React + Vite
├── packages/
│   ├── core/          ★ routing engine, state machine, code gen — ZERO I/O
│   ├── providers/     adapter interface + meta, twilio, simulated
│   ├── db/            Drizzle schema, migrations, repositories
│   ├── sdk/           published client
│   └── simulator/     harness, scenarios, reporting
```

### The one rule that matters: `packages/core` has no I/O

No database calls, no HTTP, no queue, no clock reads, no `crypto` randomness without an
injected source. Pure functions taking data and returning decisions.

This is not stylistic. It is what lets `packages/simulator` run the **real** routing engine
rather than a copy of it (R9.2). If core reaches for a database, the simulator has to
reimplement it, and the most valuable part of the project quietly becomes fake.

Dependency direction, strictly one-way:

```
api ──▶ core, db, providers
worker ──▶ core, db, providers
simulator ──▶ core, providers(simulated)
core ──▶ (nothing)
```

`core` importing from `db` or `providers` is a build-breaking error.

---

## 3. The verification state machine

```
                    ┌─────────┐
       /start ─────▶│ pending │
                    └────┬────┘
                         │
      ┌──────────────────┼──────────────────┬─────────────────┐
      │                  │                  │                 │
 correct code      TTL elapsed      5 failed attempts   all channels
      │                  │                  │            exhausted
      ▼                  ▼                  ▼                 ▼
┌──────────┐       ┌─────────┐       ┌──────────┐      ┌────────┐
│ verified │       │ expired │       │  burned  │      │ failed │
└──────────┘       └─────────┘       └──────────┘      └────────┘
     ▲                                                       ▲
     └───────── all four are TERMINAL — no transitions out ───┘
```

Rules:

1. **`pending` is the only non-terminal state.** Every transition out is one-way.
2. **Every transition is an atomic conditional UPDATE** guarded on the current state.
3. **A late event against a terminal state is a no-op, not an error.** Log and return 200.
4. Delivery attempts have their own lifecycle (`queued → sent → delivered | failed |
timed_out`) which is **independent** — a verification can be `verified` while an attempt is
   still `sent`.

---

## 4. Sequence: the fallback path

```
customer   api         worker      meta      redis/pg     user
   │        │            │          │           │          │
   ├─start─▶│            │          │           │          │
   │        ├─ route ────┼──────────┼──────────▶│          │
   │        ├─ enqueue ─▶│          │           │          │
   │◀─202───┤            │          │           │          │
   │        │            ├─ send ──▶│           │          │
   │        │            │          ├───── whatsapp ──────▶│
   │        │            ├─ schedule fallback@20s ─▶│      │
   │        │            │          │           │          │
   │        │        ····· 20s, no delivery webhook ·····  │
   │        │            │          │           │          │
   │        │            ├─ timer fires ───────▶│          │
   │        │            ├─ send SMS (SAME CODE) ──────────▶
   │        │            │          │           │          │
   │        │            │◀─ whatsapp delivered (t=25s) ───┤
   │        │            │          │           │          │
   │◀───────┤◀─ check (code from whatsapp, t=26s) ─────────┤
   │        ├─ atomic UPDATE ... WHERE status='pending' ──▶│
   │        ├─ cancel pending fallback jobs ──────────────▶│
   │◀verified                                              │
```

The reason this works is R2.3: one code, all channels. The user's code is valid regardless of
which channel actually delivered it, and regardless of arrival order.

**Fallback timeout choice.** 20s for WhatsApp, 30s for SMS, from the policy. Reasoning: waiting
for a read receipt means waiting forever, and most real users act within 15s of a code
arriving. Below ~15s you double-send constantly and pay twice; above ~30s the user has already
given up. This is a tuning parameter the simulation harness exists to test, and the value must
come from the policy, never a constant.

---

## 5. Routing pipeline

Four pure functions in `packages/core/routing`, composed:

```
RoutingInput { account, phoneHash, country, metadata, requestedChannels }
      │
      ▼
① matchPolicy(policy, input) ──────▶ candidate channels + timeouts + cost ceiling
      │
      ▼
② filterByCapability(candidates, capabilityRecord)
      │   drops channels with consecutive_failures ≥ 2
      │   reorders by confidence-weighted capability
      ▼
③ rankByScore(candidates, channelScores)
      │   orders by verification_rate, tie-break on time_to_verify p50
      ▼
④ applyCostCeiling(candidates, rates, ceiling)
      │   drops channels over budget
      ▼
RoutingPlan { orderedChannels[], timeouts, decisionLog[] }
```

Each stage appends to `decisionLog` with a reason. That log is persisted whole (R3.9) and is
what the dashboard trace view renders.

Each stage is independently unit-testable with plain objects. No mocking required, because
there is nothing to mock.

---

## 6. Queue topology

| Queue              | Trigger                  | Job                             | Notes                                                                  |
| ------------------ | ------------------------ | ------------------------------- | ---------------------------------------------------------------------- |
| `delivery`         | `/start`, fallback timer | Send one OTP on one channel     | Retries transient errors with backoff+jitter                           |
| `fallback-timer`   | After each send          | Check delivery, advance chain   | **Delayed job.** Cancelled on success. Cancellation must be idempotent |
| `webhook-ingest`   | Webhook received         | Parse, dedupe, transition state | Keeps the HTTP handler under 500ms                                     |
| `score-recompute`  | Cron, every 15m          | Rebuild `channel_scores`        | Repeatable job                                                         |
| `outbound-webhook` | State change             | Notify customer                 | LATER                                                                  |

**Cancellation is best-effort.** A fallback timer may fire after success — the processor must
re-read state and no-op if terminal. Never assume cancellation succeeded.

---

## 7. Data model

```sql
accounts            id, name, api_key_hash, api_key_prefix, status,
                    daily_cost_cap_micros, created_at

routing_policies    id, account_id, version, policy_json, active, created_at

verifications       id, account_id, phone_hash, phone_encrypted, code_hmac,
                    status, attempts_used, max_attempts, expires_at,
                    verified_at, verified_channel, time_to_verify_ms,
                    metadata_json, idempotency_key, created_at

delivery_attempts   id, verification_id, account_id, channel, provider,
                    provider_message_id, status, error_code,
                    cost_micros_at_send, sent_at, delivered_at,
                    failed_at, timeout_at

routing_decisions   id, verification_id, considered_json, chosen_channel,
                    decision_log_json, created_at

channel_capability  phone_hash, channel, capability, confidence,
                    last_success_at, consecutive_failures, updated_at

channel_scores      channel, country, carrier_class, verification_rate,
                    p50_ms, p95_ms, cost_per_success_micros,
                    window_start, window_end

provider_rates      provider, channel, country, rate_micros,
                    effective_from, effective_to

webhook_events      id, provider, provider_message_id, payload_json,
                    signature_valid, processed_at
```

**Three details that carry weight:**

- `cost_micros_at_send` on `delivery_attempts` — the rate is captured at send time, never
  looked up later (G8). Meta revises rates quarterly; without this, historical cost metrics
  rewrite themselves.
- `phone_hash` is HMAC with a dedicated pepper, distinct from the OTP pepper. It is the join
  key for `channel_capability`, so the capability cache works without a plaintext phone
  database.
- Money is `micros` integers. No floats, anywhere.

**Indexes:** partial on `verifications(status)` where `status='pending'`;
`delivery_attempts(verification_id)`; unique on
`webhook_events(provider, provider_message_id)` — that uniqueness constraint _is_ the
deduplication mechanism (R6.2), enforced by the database rather than application logic.

---

## 8. Concurrency rules

Non-negotiable, and the source of most subtle bugs if broken.

**Never read-then-write.** Every state transition is one statement:

```sql
UPDATE verifications
   SET status = 'verified', verified_at = now(), verified_channel = $2
 WHERE id = $1 AND status = 'pending'
```

Then check the affected row count. Zero rows means someone else won — return the current state,
do not error.

**Rate limiting is atomic in Redis.** Sliding-window check-and-increment in a single Lua
script, never three round trips.

**Webhook dedupe is a database constraint**, not an application check. Insert into
`webhook_events` and let the unique violation tell you it's a duplicate.

**Idempotency keys** are stored with the response, TTL 24h. A replay returns the stored
response without re-entering the pipeline.

---

## 9. Configuration and secrets

Zod-validated config module, loaded once at boot, failing hard on anything missing (R11.3).
Three separate peppers, never shared:

| Pepper              | Purpose                                |
| ------------------- | -------------------------------------- |
| `OTP_PEPPER`        | HMAC of the verification code          |
| `PHONE_HASH_PEPPER` | HMAC of phone numbers for `phone_hash` |
| `API_KEY_PEPPER`    | Additional entropy on API key hashing  |

Separate, because compromising one must not compromise the others.

---

## 10. Simulation architecture

```
scenario.yaml ──▶ ┌──────────────────────────────────┐
                  │  packages/simulator              │
   seed ─────────▶│  · seeded PRNG                   │
                  │  · virtual clock                 │
                  │  · synthetic population          │
                  └──────┬───────────────────────────┘
                         │ drives
                  ┌──────▼───────────────┐     ┌──────────────────┐
                  │  packages/core       │────▶│ SimulatedProvider│
                  │  (the REAL engine)   │     └──────────────────┘
                  └──────┬───────────────┘
                         ▼
                  report: p50/p95, fallback rate,
                  verification rate, cost/success
```

**Virtual clock.** The simulator advances time explicitly rather than sleeping, so 10,000
verifications with 20-second timeouts complete in under a minute (R9.4). This means nothing in
`core` may call `Date.now()` directly — time is injected.

**Synthetic population.** The scenario declares what share of numbers are actually reachable on
WhatsApp, how fast users respond, and how often they abandon. This is what makes G1 measurable:
a channel can deliver perfectly and still verify poorly.

**Determinism.** One seed threads through every random draw. Same seed, same report, always
(R9.3) — which is what makes A/B policy comparison meaningful.
