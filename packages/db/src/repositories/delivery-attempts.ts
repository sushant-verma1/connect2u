import { drizzle } from "drizzle-orm/postgres-js";
import type { PgClient } from "../client.js";
import { deliveryAttempts } from "../schema.js";

export type DeliveryAttempt = typeof deliveryAttempts.$inferSelect;
export type NewDeliveryAttempt = typeof deliveryAttempts.$inferInsert;

export async function insertDeliveryAttempt(
  client: PgClient,
  data: NewDeliveryAttempt,
): Promise<DeliveryAttempt> {
  const db = drizzle(client);
  const rows = await db.insert(deliveryAttempts).values(data).returning();
  const inserted = rows[0];
  if (!inserted) {
    throw new Error("delivery attempt insert returned no row");
  }
  return inserted;
}
