import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PgClient } from "../client.js";
import { routingDecisions } from "../schema.js";

export type RoutingDecision = typeof routingDecisions.$inferSelect;
export type NewRoutingDecision = typeof routingDecisions.$inferInsert;

/** R3.9: persisted whole, every time — every channel considered, the one chosen, and
 * the reason for every skip. This is the trace view's (R10.6) data source. */
export async function insertRoutingDecision(
  client: PgClient,
  data: NewRoutingDecision,
): Promise<void> {
  const db = drizzle(client);
  await db.insert(routingDecisions).values(data);
}

/** R10.6: one row per `/start` call today (routing runs once, at send time) — returns
 * the single row rather than an array so the trace endpoint doesn't need to reach into
 * one, but stays a lookup by verification_id (not an assumption baked into the schema)
 * in case a re-route-mid-flight feature ever adds a second row. */
export async function findRoutingDecisionByVerification(
  client: PgClient,
  verificationId: string,
): Promise<RoutingDecision | null> {
  const db = drizzle(client);
  const rows = await db
    .select()
    .from(routingDecisions)
    .where(eq(routingDecisions.verificationId, verificationId))
    .orderBy(routingDecisions.createdAt)
    .limit(1);
  return rows[0] ?? null;
}
