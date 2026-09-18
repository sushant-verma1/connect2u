# AGENTS.md

Operating rules for any coding agent working on this repository. Read this file before
writing code, and re-read it when starting a new phase.

---

## 1. Read order

1. **PROJECT.md** — what and why. Goals are referenced as G1–G9.
2. **REQUIREMENTS.md** — what it must do. Requirements are R*, acceptance tests are T*.
3. **ARCHITECTURE.md** — how it is structured. Non-negotiable.
4. **TECHSTACK.md** — what you may use. Exhaustive.
5. **PLAN.md** — build order. Work one phase at a time.

When these conflict, precedence is: ARCHITECTURE > REQUIREMENTS > PLAN > PROJECT. Report the
conflict rather than resolving it silently.

---

## 2. Work one phase at a time

Do not start Phase N+1 until Phase N's exit criteria are met and demonstrated.

At the start of a phase: restate the phase's goal, list the requirements it satisfies, and
state what you will build. Wait for confirmation before writing code.

At the end of a phase: run the exit-criteria tests, show the output, and stop. Do not
volunteer work from the next phase.

If a phase seems to need something from a later phase, say so and ask. Do not reach forward on
your own judgement.

---

## 3. Invariants — violating any of these is a defect, regardless of passing tests

**I1. `packages/core` has zero I/O.** No database, no HTTP, no queue, no `Date.now()`, no
`crypto` randomness without an injected source. Pure functions only. This is what lets the
simulator run the real engine (R9.2). If core needs data, the caller passes it in.

**I2. Never read-then-write on state.** Every verification state transition is a single
conditional `UPDATE ... WHERE status = 'pending'`, checked by affected row count. Zero rows
means someone else won — return current state, do not throw.

**I3. One code per verification, shared across all channels.** Never regenerate on fallback.

**I4. Plaintext codes never leave memory.** Not to logs at any level, not to responses, not to
error messages, not in dev. No exception: the public demo (`/v1/demo/routing/*`) is a pure
simulation that never generates a code at all, so the exception this invariant once carried for
it — see "Demo carve-out" in `docs/security.md` — no longer applies to anything.

**I5. Every query scoped by `account_id`.** No exceptions, from the first commit.

**I6. `Math.random` is forbidden.** `crypto.randomInt` for codes, the injected seeded PRNG in
the simulator.

**I7. Money is integer micros.** No floats for currency, anywhere.

**I8. Rates are captured at send time** onto `delivery_attempts.cost_micros_at_send`. Never
looked up at read time (G8).

**I9. Terminal states are terminal.** A late event against a terminal verification is a no-op
returning 200, not an error.

**I10. Timeouts come from the routing policy**, never a hardcoded constant.

If a requested change would violate an invariant, stop and say which one. Do not implement it
and mention the concern afterwards.

---

## 4. Dependencies

TECHSTACK.md is exhaustive. Before installing anything not listed, stop and ask, stating: what
it does, why nothing already approved covers it, its weekly downloads, last publish date, and
transitive dependency count.

**Default answer is no.** Anything on the forbidden list is a rejected change, not a
discussion.

---

## 5. Testing

**Tests are written before or alongside the code, never after as an afterthought.**

- Unit tests for everything in `packages/core` — plain objects in, decisions out, no mocking.
- Integration tests use **real Postgres and Redis via Testcontainers**. Do not mock the
  database. This project is about correctness under concurrency; a mocked database tests
  nothing that matters.
- The acceptance tests in REQUIREMENTS.md §12 are gates. T1 and T5–T8 are non-negotiable.
- A concurrency test that passes on the first run may be passing by luck. Run it 20 times.

Never weaken a test to make it pass. Never add `.skip`. If a test fails and you believe the
test is wrong, say so and explain why — do not edit it unilaterally.

---

## 6. Code style

- TypeScript `strict`. No `any`. No `as` casts to silence the compiler — if you need one,
  the types are wrong.
- No barrel files re-exporting everything; import from specific paths.
- Errors are typed and enumerated, not strings.
- No comments explaining _what_ the code does. Comments explain _why_, and only where the
  reason is non-obvious — a race condition, a provider quirk, a deliberate trade-off.
- Functions do one thing. If you're writing "and" in the name, split it.
- No premature abstraction. Two occurrences is a coincidence; three is a pattern.

---

## 7. Commits

- One logical change per commit.
- Present tense, imperative: `add fallback timer cancellation`, not `added` or `adding`.
- Reference requirement IDs where they apply: `implement atomic check transition (R1.2.2)`.
- Never commit `.env`, credentials, tokens, or real phone numbers.
- Never commit generated files, `node_modules`, or build output.

---

## 8. What to do when uncertain

**Ask.** Specifically:

- The requirement is ambiguous → quote it and describe the two readings.
- An invariant seems to conflict with a requirement → stop and report it.
- A design choice has real trade-offs → present the options with the trade-offs, and a
  recommendation. Do not pick silently.
- Something in these docs appears wrong → say so. These documents are not infallible, and a
  wrong instruction followed faithfully is worse than a challenged one.

**Do not:**

- Invent requirements not in REQUIREMENTS.md.
- Add features because they seem useful.
- Refactor code outside the current phase's scope.
- Change the schema without saying so explicitly.
- Silently substitute a different library or approach.

---

## 9. Reporting

At the end of every work session, state plainly:

1. What was built, by requirement ID.
2. What tests were written and their result.
3. What was **not** done that a reader might assume was done.
4. Any invariant you were tempted to bend, and why you didn't.
5. Open questions.

Point 3 matters most. A summary that implies more completeness than exists is the single most
damaging thing you can produce here, because it gets believed and built upon.

Do not describe work as complete when tests are failing, skipped, or unwritten. Do not use
"should work" — either it is tested or it is not.

---

## 10. Things specific to this project

**The simulator is not tooling.** It is a headline feature (G4). Treat `packages/simulator`
with the same care as production code.

**The routing engine is the differentiator.** If it degenerates into an if-else chain, the
project has failed at its stated purpose regardless of what else works (G2).

**Optimise for verification rate, not delivery rate** (G1). If you find yourself scoring
channels on delivery webhooks, you have misunderstood the project.

**WhatsApp and SMS run through `SimulatedProvider`** for demos, because of the platform
constraints in PROJECT.md. This is expected, not a gap to work around. Do not attempt to
circumvent Meta's template restrictions or suggest workarounds involving unofficial APIs,
scraping, or personal WhatsApp accounts.

**No LLM anywhere in this codebase.** Nothing here needs one.

---

## 11. Security rules

- Three separate peppers, never shared between purposes.
- Signature verification before any webhook processing, always.
- Rate limiting is atomic Redis Lua, never read-then-write.
- Dedupe via database unique constraint, never an application-level check.
- Argon2 for API keys, HMAC-SHA256 for codes. Never swap these — the reasoning is in
  PROJECT.md and it will be asked about.
- Never log, print, or return: codes, tokens, API keys, app secrets, or peppers.

---

## 12. The developer's context

This is a portfolio project for an off-campus job search, built under time pressure alongside
other work. That has consequences for how you should behave:

- **Restraint is a feature.** A `package.json` with 140 dependencies says something bad.
- **Explain trade-offs as you go.** The developer needs to defend every decision in an
  interview. A choice they can't explain is worse than a simpler choice they can.
- **Flag scope creep immediately.** There is no slack in the schedule.
- **Never pad.** Do not generate boilerplate, speculative abstractions, or configuration for
  features that don't exist. Every file must earn its place.
