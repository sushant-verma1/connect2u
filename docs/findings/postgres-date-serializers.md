# `drizzle()` disarms Date handling on the postgres.js client it is given

## The trap

`drizzle-orm/postgres-js`'s `construct()` does this to the client you hand it, before
returning a db handle (`drizzle-orm/postgres-js/driver.cjs`):

```js
const transparentParser = (val) => val;
for (const type of ["1184", "1082", "1083", "1114", "1182", "1185", "1115", "1231"]) {
  client.options.parsers[type] = transparentParser;
  client.options.serializers[type] = transparentParser;
}
client.options.serializers["114"] = transparentParser;
client.options.serializers["3802"] = transparentParser;
```

Those OIDs are every date/time type plus `json`/`jsonb`. Drizzle does it because it maps
those columns itself and wants the raw wire text, which is correct — for drizzle's own
queries. But `client.options` is the shared, mutable options object of the postgres.js
client, not a per-handle copy. The mutation is global, permanent for the life of the
client, and it happens on _every_ `drizzle(client)` call, including ones inside unrelated
repository functions.

We create one `PgClient` per process (`packages/db/src/client.ts`) and share it. Every
repository in `packages/db/src/repositories/` calls `drizzle(client)` on it. So in any
process that has run a single repository function, `client.options.serializers[1184]` is
`(val) => val`.

## What breaks

A raw postgres.js tagged query that binds a `Date`:

```ts
await client`SELECT ... WHERE da.sent_at >= ${windowStart}`;
```

postgres.js infers OID 1184 for a `Date`, looks up `options.serializers[1184]`, gets the
identity function back, and passes the still-`Date` value to `Buffer.byteLength` in the
wire encoder:

```
TypeError: The "string" argument must be of type string or an instance of Buffer or
ArrayBuffer. Received an instance of Date
```

The error names `Buffer`, points at `postgres/src/bytes.js`, and lists the parameters —
which a test runner prints as ISO strings, so they look correctly serialized. Nothing in
it mentions drizzle, and the same function called on a _fresh_ client works, which makes
this look like a caller passing the wrong type. It isn't: the bug is ordering, and the
trigger is any earlier drizzle call on the same client.

The read side is clobbered too. A raw tagged query that _selects_ a `timestamptz` gets
the wire text (`'2026-09-17 18:07:35.379+00'`) rather than a `Date`, silently — no error,
just a string where the types say `Date`. Same for `jsonb`.

## How it stayed hidden

`computeChannelStats` (`packages/db/src/repositories/channel-scores.ts`) shipped in Phase
5 binding two `Date` objects this way and was broken from that commit. It is called from
exactly one place, `score-recompute`, which had no test at all — the job silently failed
on every scheduled run, and `channel_scores` was never written. It surfaced only when the
public demo's `channel_scores` exclusion test became the first code ever to execute the
query.

## The rule

**Never bind a `Date` into a raw postgres.js tagged template in this repo.** Pass an ISO
string with an explicit cast:

```ts
await client`... WHERE da.sent_at >= ${windowStart.toISOString()}::timestamptz`;
```

The cast is not optional — without it the parameter is inferred as text and Postgres
rejects the comparison against a `timestamptz` column.

Reading a timestamp or `jsonb` back through a raw tagged query: parse it yourself, or use
drizzle for that query.

Prefer drizzle for anything it can express. `computeChannelStats` is raw because the
`PERCENTILE_CONT ... WITHIN GROUP ... FILTER` aggregate has no clean drizzle form; it is
currently the only parameterized raw query in the codebase, and keeping it the only one
keeps this trap to a single place.

## Coverage

`apps/api/test/integration/phase5-routing.integration.test.ts` runs
`createScoreRecomputeProcessor` end to end. It is the regression test: reverting the
`::timestamptz` casts reproduces the `Received an instance of Date` failure. It runs the
processor rather than `computeChannelStats` alone so the wrapper's own `Date` handling
(`windowStart`/`windowEnd` into `insertChannelScores`) stays covered too.

Any test for this must seed through a drizzle-backed repository first. A test that
touches only the raw query on a virgin client passes against broken code.
