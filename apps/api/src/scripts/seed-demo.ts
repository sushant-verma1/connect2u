import { createPgClient } from "@otp-router/db/client";
import { insertAccount } from "@otp-router/db/repositories/accounts";
import { activateRoutingPolicy } from "@otp-router/db/repositories/routing-policies";
import { ulid } from "ulid";
import { DEMO_ACCOUNT_ID } from "@otp-router/core/demo";
import { loadConfig } from "../config.js";

function hasCode(value: unknown): value is { code: unknown } {
  return value !== null && typeof value === "object" && "code" in value;
}

function hasCause(value: unknown): value is { cause: unknown } {
  return value !== null && typeof value === "object" && "cause" in value;
}

// drizzle-orm/postgres-js wraps the driver's error in a `DrizzleQueryError` whose own
// `.code` is undefined — the Postgres error code this needs to check is one level
// down, on `.cause` (confirmed against this repo's pinned drizzle-orm version; a bare
// `err.code` check falls through to `throw err` every time, which is what silently
// broke this script's claimed idempotency).
function isUniqueViolation(err: unknown): boolean {
  if (hasCode(err) && err.code === "23505") return true;
  return hasCause(err) && hasCode(err.cause) && err.cause.code === "23505";
}

/**
 * Seeds the public `/demo/routing` account: no API key row (nothing to authenticate as
 * it via `apiKeyAuth`), `password_hash`/`google_sub` both null (nothing to log in as it
 * via `sessionAuth` or Google OAuth — `auth-google.ts` links by email, and `.invalid`
 * can never be registered). No authenticated path can create anything under this
 * account. `/v1/demo/routing/*` (apps/api/src/routes/demo.ts) reads this row's routing
 * policy only — it never writes a verification, delivery attempt, or routing decision
 * for this account, so there is no plaintext code and no I4 carve-out to reason about.
 *
 * Idempotent: re-running is a no-op on the account row (23505 caught below) and simply
 * reactivates the same routing policy on the row. `apps/api/src/app.ts` only registers
 * `/v1/demo/routing/*` once this row exists — run with `pnpm --filter @otp-router/api
 * seed:demo`.
 */
const config = loadConfig();
const pg = createPgClient(config.databaseUrl);

try {
  await insertAccount(pg, {
    id: DEMO_ACCOUNT_ID,
    name: "Public demo",
    email: "demo@otp-router.invalid",
    passwordHash: null,
    googleSub: null,
    status: "active",
  });
  console.log(`Seeded demo account ${DEMO_ACCOUNT_ID}`);
} catch (err) {
  // drizzle-orm/postgres-js wraps the driver's error in a `DrizzleQueryError` whose
  // own `.code` is undefined — the Postgres error code this actually needs to check
  // is one level down, on `.cause` (confirmed against this repo's pinned drizzle-orm
  // version; a bare `err.code` check here always falls through to `throw err`, which
  // is what silently broke this script's claimed idempotency).
  if (!isUniqueViolation(err)) throw err;
  console.log(`Demo account ${DEMO_ACCOUNT_ID} already exists — skipping insert`);
}

// The /demo/routing dashboard page (apps/api/src/routes/demo.ts,
// packages/simulator/src/demo-session.ts) needs both channels to visibly time out and
// fall back inside a demo someone will actually watch, so both get the same 5s
// ceiling rather than production's asymmetric 20s/30s (CHANNEL_TIMEOUT_MS) — I10: this
// lives in the routing policy, never as a hardcoded constant in the demo route or the
// simulator.
await activateRoutingPolicy(pg, {
  id: `rtp_${ulid()}`,
  accountId: DEMO_ACCOUNT_ID,
  policyJson: {
    version: 1,
    rules: [],
    default: {
      channels: ["whatsapp", "sms"],
      timeouts_ms: { whatsapp: 5_000, sms: 5_000 },
      reason: "demo account: both channels time out fast enough to see a fallback happen",
    },
  },
});
console.log(`Activated demo routing policy for ${DEMO_ACCOUNT_ID}`);

await pg.end();
