# PROJECT.md

## What this is

A provider-independent OTP verification router.

A company integrates two REST endpoints. Underneath, the system picks the cheapest channel
likely to actually get a code into a user's hands, falls back automatically when it doesn't,
and learns from every attempt which channel works for which kind of number.

If you can't say that out loud without reading it, the project isn't finished.

---

## Why it exists

### The problem

A company that needs to verify phone numbers today picks one vendor and inherits that
vendor's prices, coverage, and outages. Switching means rewriting the integration.

Meanwhile the delivery landscape is fragmented and priced very differently by corridor.
Authentication messages to Indian numbers cost about ₹0.115 on Meta's WhatsApp rate card
(effective 1 July 2026, plus 18% GST). The authentication-international rate is roughly
₹1.75–2.50 — around 22× higher. Indian domestic SMS through a local provider is priced
differently again. No single vendor is cheapest everywhere.

### The position

This sits _above_ providers rather than being one.

```
        Twilio Verify                    This project
   ┌──────────────────────┐      ┌──────────────────────────┐
   │  Verify API          │      │  Verify API              │
   ├──────────────────────┤      ├──────────────────────────┤
   │  Twilio WhatsApp     │      │  Meta direct │ MSG91 │   │
   │  Twilio SMS          │      │  Twilio      │ any   │   │
   │  Twilio carriers     │      │  ...swappable            │
   └──────────────────────┘      └──────────────────────────┘
      one vendor's network          any vendor, one contract
```

### What is actually differentiated

Twilio Verify already does WhatsApp-first with SMS fallback. **"We do fallback" is not a
differentiator and claiming it will get you caught.** These four are defensible:

1. **Provider independence.** WhatsApp direct to Meta at Meta's rate, Indian SMS to a
   domestic provider, international SMS to Twilio — all behind one unchanging customer API.
2. **Outcome-based routing.** Optimises on verification rate, not delivery rate. See G1.
3. **Explainable decisions.** Every routing choice persists what was considered and why each
   channel was skipped. Twilio's routing is a black box.
4. **Customer-editable policy.** Declarative routing rules changed via API with no deploy.

### What is not differentiated — say so when asked

Carrier relationships, deliverability at scale, compliance certifications, global coverage,
support, fraud signals from billions of verifications, uptime history. Naming these honestly
reads better than pretending they don't exist.

---

## End goals

Everything in PLAN.md serves one of these. Referenced elsewhere as G1–G9.

### G1 — Optimise for verification rate, not delivery rate

**The most important idea in the project.**

A delivery webhook says the message reached a device. It does not say the user saw it or used
it. These diverge badly: WhatsApp reports `delivered` while a message sits unread in an
archived chat; SMS lands in a blocked folder on several Android OEMs and still reports
delivered.

A router scored on delivery webhooks learns the wrong thing and confidently routes to a
channel nobody reads.

Score on outcomes instead. Per `(channel, country, carrier_class)`:

- `verification_rate` — successful `/check` within TTL ÷ sends
- `time_to_verify` p50 and p95 — send → check
- `cost_per_successful_verification` — spend ÷ successes

That third metric is what a customer actually buys. A channel costing a tenth as much that
verifies half as often is not cheaper.

### G2 — A policy engine, not an if-else chain

The fastest way to lose credibility is a feature called "intelligent routing engine" that
turns out to be `if (country === 'IN') tryWhatsApp()`. An interviewer finds that in ninety
seconds.

Rules are declarative, per-account, versioned, stored in Postgres, and changeable through the
API **with no deploy**.

### G3 — The channel capability cache

There is no reliable way to ask Meta whether a number is on WhatsApp. So the first send to an
unknown number is a bet that burns seconds before fallback.

Learn it instead. Per hashed number: capability (`unknown`/`likely`/`unlikely`), confidence
that decays with age, last success per channel, consecutive failures. Known-good numbers go
WhatsApp-first immediately. Twice-failed numbers skip it. Unknown numbers get one bounded
attempt.

### G4 — A deterministic simulation harness

The highest-leverage thing in the build.

A seeded scenario file drives `SimulatedProvider`: latency distributions, failure rates,
duplicate and out-of-order webhooks, late deliveries arriving _after_ fallback fired. Push
10,000 synthetic verifications through the **real** routing engine and emit p50/p95, fallback
rate, verification rate, cost per success.

Solves three problems at once: cold start, resume numbers without real traffic, and
demonstrating you can test a distributed system — rarer than building one.

### G5 — Correctness under concurrency

The race that will bite you:

```
t=0s    WhatsApp send dispatched
t=20s   no delivery webhook → SMS fallback fires
t=25s   WhatsApp delivery webhook arrives
t=26s   user submits the code from WhatsApp
```

One code shared across all channels. Atomic conditional updates only. Explicit state machine
with terminal states. Idempotent, dedupable, order-tolerant webhooks.

### G6 — Webhooks are hostile in both directions

Inbound: signature verification, dedupe on provider message ID, tolerate out-of-order, respond
200 fast and process async. Outbound: signed payloads, backoff retry, dead-letter.

### G7 — Multi-tenancy and idempotency from commit one

API keys per account, every query scoped by `account_id`, per-account and per-number rate
limits, `Idempotency-Key` on `/start`. Cheap now, miserable to retrofit.

### G8 — Version the cost data

Store the applicable rate **on the delivery attempt row at send time**. Meta updates its rate
card roughly quarterly. Look it up at read time and your historical cost metrics silently
rewrite themselves.

### G9 — A tiny client SDK

Typed wrapper over the two endpoints. Half a day. Makes "one API for the company" concrete.

---

## Security posture

It's an auth product; expect probing.

**Hashing.** HMAC-SHA256 with a server-side pepper, `timingSafeEqual` compare. **Not** bcrypt
or argon2 — a 6-digit code has a 10⁶ search space, so slow hashing buys almost nothing and the
attempt cap is the real defence. Say exactly that when asked; it shows reasoning rather than
pattern-matching "password → argon2". Argon2 _is_ correct for API keys.

**Attempt caps.** 5 wrong submissions burns the code permanently. A burn, not a lockout.

**Toll fraud / SMS pumping.** The actual attack: an attacker triggers thousands of sends to
premium-rate numbers they collect revenue from. Defences: per-account daily spend ceiling that
trips into manual review, velocity limits by number prefix, anomaly alerting on country-mix
shift. Almost no student project handles this.

**Always.** No plaintext codes in logs, any environment. Phone numbers hashed everywhere
except the active verification record. Codes single-use.

---

## Hard constraints

These are settled facts, discovered during setup. Do not design around wishes.

| Constraint                                                                                                                                                                                                                                       | Consequence                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Authentication templates cannot be created on a test WABA.** Meta gates template creation behind production setup, which requires a registered business, business verification with documents, a dedicated phone number, and a payment method. | WhatsApp is a **simulated channel** for demos. The `MetaProvider` adapter is still written properly against the real API contract, and a live `hello_world` send is recorded as proof the integration works. |
| **Twilio trial accounts expire 30 days after signup** and restrict senders to Twilio-provided templates — custom message bodies are unavailable on trial.                                                                                        | Twilio signup is deferred to Phase 4 at the earliest, and may be skipped entirely. SMS runs through `SimulatedProvider`.                                                                                     |
| **Indian SMS requires TRAI DLT registration** — registered entity, approved header, approved templates. Unavailable to an individual.                                                                                                            | Real Indian SMS is out of reach. Do not plan around it.                                                                                                                                                      |
| **Meta device-trust delays** high-privilege actions from unfamiliar devices.                                                                                                                                                                     | Generate the permanent system-user token when the block clears. The 24h token suffices in the meantime.                                                                                                      |

None of these touch Phases 0–3 or 5–9. The project's value — routing, fallback, race
handling, simulation — is unaffected.

---

## Out of scope

Write this in the README. Articulated scoping reads as maturity; unexplained gaps read as
abandonment.

| Excluded                                   | Reason                                                                                                                                                                                                                                                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ads or promotional content in messages** | Structurally impossible. WhatsApp authentication templates use a preset format with no URLs, media, or emojis, and only authentication templates may carry a passcode. Mixing promotional content risks reclassification of every template on the account. Indian SMS is blocked equivalently by DLT. |
| Voice OTP                                  | A whole telephony surface for one more chart bar                                                                                                                                                                                                                                                      |
| Push channel                               | Requires per-customer mobile SDK integration                                                                                                                                                                                                                                                          |
| Email channel in v1                        | Least interesting adapter, deepest deliverability rabbit hole                                                                                                                                                                                                                                         |
| Billing / payments                         | Track cost, don't collect money                                                                                                                                                                                                                                                                       |
| Template management UI                     | Meta's console does this                                                                                                                                                                                                                                                                              |
| Real-time dashboard                        | 10s polling is fine                                                                                                                                                                                                                                                                                   |
| Multi-region                               | One region                                                                                                                                                                                                                                                                                            |
| Magic links / passkeys                     | Different product                                                                                                                                                                                                                                                                                     |
| Any LLM anywhere                           | Nothing here needs one; adding one weakens the project                                                                                                                                                                                                                                                |

---

## Definition of done

Not "all features built." These six:

1. `pnpm simulate --scenario=india-mixed --seed=42` produces a reproducible report with
   p50/p95, fallback rate, verification rate, and cost per successful verification.
2. A demo shows a verification starting on WhatsApp, no response, fallback firing on a visible
   timer, and the dashboard updating.
3. Routing behaviour changes through an API call with no deploy.
4. README carries the architecture diagram, fallback-timing reasoning, state machine,
   out-of-scope list, and an honest note on the platform constraints above.
5. A concurrency test proves 50 simultaneous correct `/check` calls yield exactly one success.
6. Three measured numbers exist, with the method recorded for each.

**Target resume line:**

> Built a provider-independent OTP verification router (Node/TS, Postgres, Redis, BullMQ)
> with outcome-scored channel selection and automatic fallback; measured **X%** lower cost per
> successful verification vs SMS-only routing at **Y ms** p95 across 10k simulated
> verifications.

Fill X and Y from your own harness. Never invent them — you will be asked how you measured.

---

## Scope warning

This is a **four-week build** at nine focused hours a day. It does not fit alongside
everything else currently queued before December. Decide what it displaces before writing the
first line of code, not in November.
