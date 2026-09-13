import { drizzle } from "drizzle-orm/postgres-js";
import type { PgClient } from "../client.js";
import { routingDecisions } from "../schema.js";

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
