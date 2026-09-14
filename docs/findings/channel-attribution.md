# The channel that never got credit

## The bug

`channel_verified` was the string `"whatsapp"` on every verified verification the system
had ever produced. Not usually, not as a default in ambiguous cases — always, including
verifications where WhatsApp was skipped before a single message was sent.

One line, `apps/api/src/services/check-verification.ts`:

```ts
channel: verification.verifiedChannel ?? "whatsapp",
```

`verified_channel` is written in exactly one place — `markVerified`
(`packages/db/src/repositories/verifications.ts`), which is this same call. Nothing sets
it earlier, so the column is NULL on every pending row, so the `??` always took the
right-hand branch. The field looked like attribution logic and was a constant.

## Why it mattered more than a wrong response field

`channel_scores` counts a channel's successes with
(`packages/db/src/repositories/channel-scores.ts`):

```sql
COUNT(*) FILTER (WHERE v.status = 'verified' AND v.verified_channel = da.channel)
```

With `verified_channel` pinned to `"whatsapp"`:

- **SMS rows**: the filter never matched. `verifications = 0`, so `verification_rate =
0.0` and both percentiles NULL → written as `0`, for every window, forever.
- **WhatsApp rows**: credited for every verified verification that had a WhatsApp send,
  including codes the user read off the SMS after WhatsApp timed out. That number was
  never WhatsApp's verification rate — it was the whole chain's success rate on
  verifications that happened to start with WhatsApp.

Then it closed the loop. `rankByScore` (`packages/core/src/routing/rank-by-score.ts`)
orders candidates by `verificationRate` descending, with `UNSCORED_VERIFICATION_RATE =
0.5` for channels with no history. Once one score-recompute window wrote SMS at `0.0`,
SMS ranked below even a never-measured channel — permanently, in every country, for
every account. WhatsApp stayed first, kept collecting the chain's credit, and kept
confirming its own position.

So G1 — "optimise for verification rate, not delivery rate", the project's central
claim — was running on a metric that could only ever produce one answer. A router scored
on delivery webhooks learns the wrong thing; this one wasn't learning at all.

## How it was found

Not by a test. A manual run of the fallback demo in the README: WhatsApp timed out, the
SMS attempt was marked `delivered` by hand via `POST /v1/webhooks/simulated`, `/check`
succeeded — and the response said `"channel_verified": "whatsapp"`. The question asked
was "how is attribution decided, and is first-attempt bias skewing `channel_scores`?"
The answer turned out to be that there was no attribution at all.

Nothing in the suite covered it. Phases 3–9 all passed throughout: the fallback tests
assert attempt state (`timed_out`, `delivered`) and verification status, and the routing
tests assert chosen channels and skip reasons. No test read `verified_channel`, and
`channel_scores` had no integration coverage at all — the recompute job was tested for
"writes rows", not for "writes rows that mean anything". A default that is always
plausible produces no failing assertion anywhere.

## Why the simulation results are unaffected

The headline numbers (4.6pp higher verification rate, 9.7s lower p95) come from
`packages/simulator`, which never touches this code path. Its runner attributes to the
channel actually in flight when the synthetic user responds
(`packages/simulator/src/runner.ts` — `verifiedChannel = channel`, inside the loop over
the chain), which is correct attribution, and it feeds its own in-memory scorer rather
than `channel_scores`. So the simulator was modelling the router the production code was
supposed to be, and the gap stayed invisible because the two never share an attribution
rule. That is its own lesson: a simulator that reimplements the behaviour it is meant to
measure cannot detect that the real thing does something else.

## The fix, and what it can and cannot claim

`attributeChannel` in `apps/api/src/services/check-verification.ts`: the most recently
`delivered` attempt, falling back to the most recently `sent` one, ordered on the event
timestamps rather than attempt id (a late `delivered` webhook, R4.8, can land after the
next channel was already sent). No attributable attempt → NULL, recorded as NULL and
surfaced as `null`, never a channel name.

This is a **convention, not a measurement**, and has to be read that way. Every channel
in a chain carries the same code by design (R2.3 — the code is never regenerated on
fallback), and nothing in the system observes which message a user read; `/check`
receives six digits and no provenance. There is no data that could settle it.

Last-delivered was chosen over first-attempt because the score is consumed by the thing
that picks the first attempt. Crediting the first attempt credits the channel routing
already preferred, so `verification_rate` would measure chain position and then feed that
measurement back into the ordering — the same closed loop as the bug, just less obvious.
Last-delivered is biased the other way, toward whatever the chain ended on, but that
channel's message is the one that was most recently in front of the user, and it is the
only rule that can move credit away from the incumbent.

Residual bias that no attribution rule can remove: a channel used mainly as a fallback is
measured only on verifications where the previous channel already failed — a harder
population than the one the first channel is measured on. The per-channel rate is
conditional on the position the channel actually got used from. That belongs in any
reading of `channel_scores`.

## Consequences for existing data

Every `channel_scores` row ever written is derived from the constant and is wrong:
truncate the table. Nothing else reads it (only `findLatestScoresByCountry`, on the
routing path), and an empty table is a clean cold start — every channel falls back to
`UNSCORED_VERIFICATION_RATE` and the chain runs in policy order until the first post-fix
window is recomputed.

Truncating scores is not sufficient on its own. `verifications.verified_channel` is
already written on historical rows and the fix does not backfill it, so the 24h recompute
window (`WINDOW_MS`, `apps/worker/src/processors/score-recompute.ts`) keeps reading
pre-fix verifications until it rolls past them. Either wait out one full window before
trusting the scores, or backfill with the same rule the fix applies:

```sql
UPDATE verifications v SET verified_channel = (
  SELECT da.channel FROM delivery_attempts da
  WHERE da.verification_id = v.id
    AND (da.delivered_at IS NOT NULL OR da.sent_at IS NOT NULL)
  ORDER BY (da.delivered_at IS NOT NULL) DESC, COALESCE(da.delivered_at, da.sent_at) DESC
  LIMIT 1
)
WHERE v.status = 'verified';
```

## `rank-by-score` against a genuine 0.0

Now that a real `0.0` can be measured, the question is whether ranking it below an
unmeasured channel's `0.5` is intended. It is: the constant is documented as cold-start
neutrality, and a channel measured at zero verifications across a full window _should_
rank below a channel nobody has data on. Two things keep that from becoming an absorbing
state:

- `rankByScore` **reorders** the chain, it does not filter it. A channel demoted to last
  is still sent on whenever the channel ahead of it fails, so it keeps accumulating sends
  and can climb back out. Dropping a channel entirely is the capability cache's job
  (R3.6), on per-number evidence, not the score's.
- `computeChannelStats` only emits rows for `sends > 0`, so a `0.0` always means
  "measured, and it failed", never "no data".

One incidental sharp edge, found while confirming the above and fixed with it:
`score-recompute` wrote `Math.round(stat.p50Ms ?? 0)`, so a channel with sends but no
verifications got `p50Ms = 0` — which the p50 tie-break reads as "instant" rather than
"unknown". Same silent-default pattern as `?? "whatsapp"`: a plausible value standing in
for absent data. `p50_ms`/`p95_ms` are now nullable (migration `0007`), the job writes
NULL when the window verified nothing, and `rankByScore`'s existing
`?? UNSCORED_P50_MS` turns that into positive infinity — last on the tie-break, where
unmeasured belongs.
