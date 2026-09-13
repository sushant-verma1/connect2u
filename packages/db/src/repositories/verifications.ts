import { and, eq, gt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PgClient } from "../client.js";
import { verifications } from "../schema.js";

export type Verification = typeof verifications.$inferSelect;
export type NewVerification = typeof verifications.$inferInsert;

export async function insertVerification(
  client: PgClient,
  data: NewVerification,
): Promise<Verification> {
  const db = drizzle(client);
  const rows = await db.insert(verifications).values(data).returning();
  const inserted = rows[0];
  if (!inserted) {
    throw new Error("verification insert returned no row");
  }
  return inserted;
}

/** R8.1/R8.2: every read is scoped by account_id, no exceptions. */
export async function findVerificationScoped(
  client: PgClient,
  id: string,
  accountId: string,
): Promise<Verification | null> {
  const db = drizzle(client);
  const rows = await db
    .select()
    .from(verifications)
    .where(and(eq(verifications.id, id), eq(verifications.accountId, accountId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * I2: single atomic conditional UPDATE. `expires_at > now()` is evaluated in Postgres,
 * not the application, so a verification cannot flip to `verified` past its expiry no
 * matter how the caller's clock drifts. Returns null when the WHERE predicate matched
 * zero rows — the caller already lost the race or the verification is not eligible.
 */
export async function markVerified(
  client: PgClient,
  params: { id: string; accountId: string; channel: string; timeToVerifyMs: number },
): Promise<Verification | null> {
  const db = drizzle(client);
  const rows = await db
    .update(verifications)
    .set({
      status: "verified",
      verifiedAt: sql`now()`,
      verifiedChannel: params.channel,
      timeToVerifyMs: params.timeToVerifyMs,
    })
    .where(
      and(
        eq(verifications.id, params.id),
        eq(verifications.accountId, params.accountId),
        eq(verifications.status, "pending"),
        gt(verifications.expiresAt, sql`now()`),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/**
 * I2: attempts_used and the burn transition are computed by Postgres from the row it
 * already holds under lock, in the same statement — never read-then-write.
 */
export async function recordFailedAttempt(
  client: PgClient,
  params: { id: string; accountId: string },
): Promise<Verification | null> {
  const db = drizzle(client);
  const rows = await db
    .update(verifications)
    .set({
      attemptsUsed: sql`${verifications.attemptsUsed} + 1`,
      status: sql`CASE WHEN ${verifications.attemptsUsed} + 1 >= ${verifications.maxAttempts} THEN 'burned' ELSE 'pending' END::verification_status`,
    })
    .where(
      and(
        eq(verifications.id, params.id),
        eq(verifications.accountId, params.accountId),
        eq(verifications.status, "pending"),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

export async function markExpired(
  client: PgClient,
  params: { id: string; accountId: string },
): Promise<Verification | null> {
  const db = drizzle(client);
  const rows = await db
    .update(verifications)
    .set({ status: "expired" })
    .where(
      and(
        eq(verifications.id, params.id),
        eq(verifications.accountId, params.accountId),
        eq(verifications.status, "pending"),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/**
 * State machine terminal transition "all channels exhausted" (ARCHITECTURE.md §3).
 * Same atomic-conditional-UPDATE shape as every other transition here — a verification
 * that already left `pending` (verified, expired, burned, or already failed) is left
 * alone, which is what makes this safe to call from a fallback path that may race a
 * `/check` call.
 */
export async function markFailed(
  client: PgClient,
  params: { id: string; accountId: string },
): Promise<Verification | null> {
  const db = drizzle(client);
  const rows = await db
    .update(verifications)
    .set({ status: "failed" })
    .where(
      and(
        eq(verifications.id, params.id),
        eq(verifications.accountId, params.accountId),
        eq(verifications.status, "pending"),
      ),
    )
    .returning();
  return rows[0] ?? null;
}
