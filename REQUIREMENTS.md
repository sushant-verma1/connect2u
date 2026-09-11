# REQUIREMENTS.md

Every requirement is numbered, testable, and tagged:

- **[MVP]** — no demo without it
- **[V1]** — needed for the project to be defensible
- **[LATER]** — cut freely if time runs short
- **[OUT]** — deliberately excluded

A requirement is met when a test asserts it, not when the code looks right.

---

## 1. Public API

### R1.1 `POST /v1/verification/start` **[MVP]**

```http
POST /v1/verification/start
Authorization: Bearer sk_test_...
Idempotency-Key: 9f2c8a1e-...
Content-Type: application/json

{
  "phone_number": "+919876543210",
  "channels": ["whatsapp", "sms"],
  "locale": "en",
  "code_length": 6,
  "ttl_seconds": 300,
  "metadata": { "flow": "login" }
}
```

`202 Accepted`:

```json
{
  "verification_id": "ver_01HX7Z...",
  "status": "pending",
  "channel_attempted": "whatsapp",
  "expires_at": "2026-09-09T12:05:00Z"
}
```

| #      | Requirement                                                                               | Tag |
| ------ | ----------------------------------------------------------------------------------------- | --- |
| R1.1.1 | Normalise `phone_number` to E.164; reject invalid with `422`                              | MVP |
| R1.1.2 | `channels` optional — routing policy decides when omitted                                 | V1  |
| R1.1.3 | `code_length` 4–8, default 6; `ttl_seconds` 60–900, default 300                           | MVP |
| R1.1.4 | `metadata` opaque, max 4KB, returned verbatim on check                                    | MVP |
| R1.1.5 | Respond within 100ms regardless of provider latency — delivery is async                   | MVP |
| R1.1.6 | Replay of an `Idempotency-Key` within 24h returns the original response and sends nothing | V1  |
| R1.1.7 | Enforce per-number, per-account and per-IP rate limits; `429` with `Retry-After`          | MVP |
| R1.1.8 | Never return the code in any response, any environment                                    | MVP |

### R1.2 `POST /v1/verification/check` **[MVP]**

```json
{ "verification_id": "ver_01HX7Z...", "code": "483920" }
```

```json
{
  "verification_id": "ver_01HX7Z...",
  "status": "verified",
  "channel_verified": "whatsapp",
  "attempts_used": 1,
  "metadata": { "flow": "login" }
}
```

| #      | Requirement                                                                                       | Tag |
| ------ | ------------------------------------------------------------------------------------------------- | --- |
| R1.2.1 | Compare via HMAC + `crypto.timingSafeEqual`; never string equality                                | MVP |
| R1.2.2 | Status transition is a single atomic conditional UPDATE; exactly one concurrent caller wins       | V1  |
| R1.2.3 | Increment attempts; the 5th failure burns the code permanently                                    | MVP |
| R1.2.4 | On success, cancel all pending fallback jobs for that verification                                | V1  |
| R1.2.5 | Record `verified_channel` and `time_to_verify_ms`                                                 | V1  |
| R1.2.6 | Failure statuses: `invalid_code`, `expired`, `already_verified`, `attempts_exceeded`, `not_found` | MVP |
| R1.2.7 | A code delivered by a channel that was later superseded still verifies                            | V1  |

### R1.3 `GET /v1/verification/:id` **[V1]**

Returns current status, expiry, and per-channel attempt list with statuses. Never the code.

### R1.4 `POST /v1/verification/:id/cancel` **[LATER]**

Terminal-state the verification and cancel pending fallbacks.

### R1.5 `POST /v1/verification/:id/resend` **[LATER]**

Force the next channel. Rate limited hard — this is a toll-fraud vector.

### R1.6 `GET/PUT /v1/accounts/me/routing-policy` **[V1]**

Read and replace the account's routing policy. `PUT` validates against the policy schema and
creates a new version rather than mutating in place.

---

## 2. OTP lifecycle

| #    | Requirement                                                                              | Tag   |
| ---- | ---------------------------------------------------------------------------------------- | ----- |
| R2.1 | Generate with `crypto.randomInt`; `Math.random` is forbidden                             | MVP   |
| R2.2 | Store only HMAC-SHA256(code, pepper); plaintext never persisted                          | MVP   |
| R2.3 | **One code per verification, shared across every channel.** Never regenerate on fallback | MVP   |
| R2.4 | Redis TTL drives expiry; Postgres holds the durable record                               | MVP   |
| R2.5 | Single use — burned on success                                                           | MVP   |
| R2.6 | Max 5 check attempts, then permanent burn                                                | MVP   |
| R2.7 | Alphanumeric code option                                                                 | LATER |

---

## 3. Routing engine

| #     | Requirement                                                                                                                   | Tag |
| ----- | ----------------------------------------------------------------------------------------------------------------------------- | --- |
| R3.1  | Policies are declarative JSON, per-account, versioned, Zod-validated, stored in Postgres                                      | V1  |
| R3.2  | A rule matches on country, prefix, risk level, or metadata; yields ordered channels, per-channel timeouts, and a cost ceiling | V1  |
| R3.3  | Changing routing behaviour requires **no deploy and no restart**                                                              | V1  |
| R3.4  | Evaluation is four separately-testable pure functions: policy match → capability filter → score ranking → cost ceiling        | V1  |
| R3.5  | Capability cache keyed on HMAC of the number; never plaintext                                                                 | V1  |
| R3.6  | Capability confidence decays with age; success raises, failure lowers                                                         | V1  |
| R3.7  | Scores aggregate **verification rate**, not delivery rate, per `(channel, country, carrier_class)`                            | V1  |
| R3.8  | Scores are precomputed by a scheduled job; never computed at request time                                                     | V1  |
| R3.9  | Every decision persists channels considered, chosen channel, and a reason per skip                                            | V1  |
| R3.10 | A channel exceeding the policy cost ceiling is excluded and the exclusion logged                                              | V1  |

**Example policy:**

```json
{
  "version": 3,
  "rules": [
    {
      "match": { "country": "IN" },
      "channels": ["whatsapp", "sms"],
      "timeouts_ms": { "whatsapp": 20000, "sms": 30000 },
      "max_cost_micros": 5000
    },
    {
      "match": { "risk": "high" },
      "channels": ["sms"],
      "reason": "no fallback for high-risk flows"
    }
  ],
  "default": { "channels": ["sms"] }
}
```

---

## 4. Delivery and fallback

| #    | Requirement                                                                                                    | Tag |
| ---- | -------------------------------------------------------------------------------------------------------------- | --- |
| R4.1 | Delivery runs on a queue; the API never blocks on a provider                                                   | MVP |
| R4.2 | Fallback timer is a delayed queue job scheduled at send time                                                   | MVP |
| R4.3 | Timer cancellation is idempotent — it will fire twice                                                          | MVP |
| R4.4 | Fallback triggers: hard provider error, delivery-failed webhook, or timeout with no delivery confirmation      | MVP |
| R4.5 | Per-channel timeout comes from the policy, not a global constant                                               | V1  |
| R4.6 | Transient errors retry with exponential backoff + jitter; permanent errors fall back immediately without retry | V1  |
| R4.7 | Chain capped at N channels per verification                                                                    | MVP |
| R4.8 | A delivery landing after fallback fired still permits verification                                             | V1  |
| R4.9 | Failed jobs dead-letter after N attempts, inspectable via an endpoint                                          | V1  |

---

## 5. Provider adapters

| #    | Requirement                                                                                                        | Tag   |
| ---- | ------------------------------------------------------------------------------------------------------------------ | ----- |
| R5.1 | Common interface: `send()`, `parseWebhook()`, `verifySignature()`, `mapErrorCode()`                                | MVP   |
| R5.2 | Swapping a provider changes no customer-facing behaviour                                                           | MVP   |
| R5.3 | `SimulatedProvider` — configurable latency, failure rate, duplicate webhooks, out-of-order webhooks, late delivery | MVP   |
| R5.4 | `MetaProvider` — Cloud API send, status webhook parsing, `X-Hub-Signature-256` verification                        | V1    |
| R5.5 | `TwilioProvider` — SMS send, status callback parsing, signature validation                                         | LATER |
| R5.6 | Errors map to a shared enum: `invalid_number`, `not_on_channel`, `rate_limited`, `provider_error`, `blocked`       | V1    |
| R5.7 | A second SMS provider, to prove the abstraction holds                                                              | LATER |
| R5.8 | Per-provider circuit breaker                                                                                       | LATER |

**Note:** per PROJECT.md constraints, `SimulatedProvider` is the primary path for both
channels. `MetaProvider` is written against the real contract and verified with a live
`hello_world` send; it is not exercised with authentication templates.

---

## 6. Webhooks

### Inbound

| #    | Requirement                                                                   | Tag |
| ---- | ----------------------------------------------------------------------------- | --- |
| R6.1 | Verify provider signature before any processing; reject invalid with `401`    | MVP |
| R6.2 | Dedupe on provider message ID — duplicates cause exactly one state transition | MVP |
| R6.3 | Out-of-order arrival yields the correct terminal state                        | V1  |
| R6.4 | Respond `200` within 500ms; process on a queue                                | MVP |
| R6.5 | Unknown event types log and no-op; never throw                                | MVP |
| R6.6 | Persist every raw webhook payload with its signature-valid flag               | V1  |

### Outbound **[LATER]**

`verification.verified` / `.expired` / `.failed`, HMAC-signed with timestamp, backoff retry,
dead-letter, per-account endpoint config.

---

## 7. Security and abuse prevention

| #    | Requirement                                                                                                 | Tag   |
| ---- | ----------------------------------------------------------------------------------------------------------- | ----- |
| R7.1 | Sliding-window rate limits, atomic via Redis Lua: per number, per account, per IP — three separate ceilings | MVP   |
| R7.2 | Plaintext codes never written to logs at any level, any environment                                         | MVP   |
| R7.3 | Phone numbers hashed everywhere except the active verification record                                       | V1    |
| R7.4 | API keys hashed at rest with argon2; a non-secret prefix identifies them                                    | V1    |
| R7.5 | Per-account daily spend ceiling; breach trips the account to `manual_review` and halts sends                | V1    |
| R7.6 | Velocity limits per number prefix                                                                           | V1    |
| R7.7 | Alert on sudden country-mix shift                                                                           | V1    |
| R7.8 | API key rotation with an overlap window                                                                     | LATER |
| R7.9 | Number and prefix blocklist                                                                                 | LATER |

---

## 8. Multi-tenancy

| #    | Requirement                                                                    | Tag   |
| ---- | ------------------------------------------------------------------------------ | ----- |
| R8.1 | Every table carrying customer data has `account_id`; every query filters on it | MVP   |
| R8.2 | No endpoint can return another account's data — asserted by test               | MVP   |
| R8.3 | Per-account quotas and routing policies                                        | V1    |
| R8.4 | Sandbox key mode forcing `SimulatedProvider`                                   | LATER |

---

## 9. Simulation harness

**A headline feature, not tooling.**

| #    | Requirement                                                                                                                                      | Tag |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --- |
| R9.1 | YAML scenario: per-channel latency distributions, failure rates, webhook chaos rates, late-delivery probability, share of population on WhatsApp | V1  |
| R9.2 | Runs the **real** routing engine and state machine — no reimplementation                                                                         | V1  |
| R9.3 | Seeded PRNG: same seed → byte-identical report                                                                                                   | V1  |
| R9.4 | Simulated clock; a 10k run completes in under 60s                                                                                                | V1  |
| R9.5 | Report: p50/p95 time-to-verify, fallback rate, verification rate, cost per success, channel distribution                                         | V1  |
| R9.6 | Human table plus machine-diffable JSON                                                                                                           | V1  |
| R9.7 | A/B mode: two policies against identical traffic, printing deltas                                                                                | V1  |
| R9.8 | Presets: `india-mixed`, `whatsapp-degraded`, `cold-start`                                                                                        | V1  |
| R9.9 | Runs in CI; a routing regression fails the build                                                                                                 | V1  |

---

## 10. Dashboard

Build last. Cap at three days.

| #     | Requirement                                                                                                                 | Tag   |
| ----- | --------------------------------------------------------------------------------------------------------------------------- | ----- |
| R10.1 | Reads a materialised view; no live aggregation                                                                              | V1    |
| R10.2 | Volume over time; verification rate by channel; latency p50/p95                                                             | V1    |
| R10.3 | Cost per successful verification, using rates captured at send time                                                         | V1    |
| R10.4 | Failure breakdown by normalised error code                                                                                  | V1    |
| R10.5 | Provider comparison table                                                                                                   | V1    |
| R10.6 | **Single-verification trace** — every attempt, every webhook, the routing decision, and the reason each channel was skipped | V1    |
| R10.7 | Polling refresh, 10s                                                                                                        | V1    |
| R10.8 | Policy editor; live event tail                                                                                              | LATER |

R10.6 is the screen that demonstrates the system rather than decorating it. Build it properly.

---

## 11. Operational

| #     | Requirement                                                                           | Tag   |
| ----- | ------------------------------------------------------------------------------------- | ----- |
| R11.1 | Structured JSON logs with `verification_id` correlation across API → worker → webhook | V1    |
| R11.2 | `/health` and `/ready`                                                                | MVP   |
| R11.3 | Config validated by Zod at boot; missing env vars fail fast                           | MVP   |
| R11.4 | Migrations versioned and committed                                                    | MVP   |
| R11.5 | Seed script producing a working local account                                         | MVP   |
| R11.6 | OpenAPI spec generated from Zod schemas                                               | V1    |
| R11.7 | Prometheus `/metrics`; OpenTelemetry tracing                                          | LATER |

---

## 12. Acceptance tests

These must exist and pass. They are the requirements that matter most.

| #   | Test                                                                  | Gate             |
| --- | --------------------------------------------------------------------- | ---------------- |
| T1  | 50 concurrent `/check` with the correct code → exactly one `verified` | **Phase 1 exit** |
| T2  | Full happy path against real Postgres + Redis via Testcontainers      | Phase 1 exit     |
| T3  | Expiry path and attempt-exhaustion path                               | Phase 1 exit     |
| T4  | Idempotency-Key replay → original response, zero additional sends     | Phase 7          |
| T5  | Late delivery after fallback fired → still verifies                   | **Phase 3 exit** |
| T6  | Duplicate webhook → single state transition                           | **Phase 3 exit** |
| T7  | Out-of-order webhooks → correct terminal state                        | **Phase 3 exit** |
| T8  | Success webhook racing the fallback timer → one channel used          | **Phase 3 exit** |
| T9  | Cross-tenant read attempt → denied                                    | Phase 1 exit     |
| T10 | Same seed → identical simulation report                               | Phase 6 exit     |
| T11 | Invalid webhook signature → `401`, no state change                    | Phase 4 exit     |

T1 and T5–T8 are non-negotiable. They are the difference between this and a queue tutorial.
