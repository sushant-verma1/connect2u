import { and, eq } from "drizzle-orm";
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

export async function findDeliveryAttempt(
  client: PgClient,
  id: string,
): Promise<DeliveryAttempt | null> {
  const db = drizzle(client);
  const rows = await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function findDeliveryAttemptsByVerification(
  client: PgClient,
  verificationId: string,
): Promise<DeliveryAttempt[]> {
  const db = drizzle(client);
  return db
    .select()
    .from(deliveryAttempts)
    .where(eq(deliveryAttempts.verificationId, verificationId));
}

/** R6.2: how an inbound webhook finds the attempt it's reporting on. */
export async function findDeliveryAttemptByProviderMessageId(
  client: PgClient,
  providerMessageId: string,
): Promise<DeliveryAttempt | null> {
  const db = drizzle(client);
  const rows = await db
    .select()
    .from(deliveryAttempts)
    .where(eq(deliveryAttempts.providerMessageId, providerMessageId))
    .limit(1);
  return rows[0] ?? null;
}

export async function markDeliveryAttemptSent(
  client: PgClient,
  params: { id: string; providerMessageId: string; costMicrosAtSend?: number | null },
): Promise<DeliveryAttempt | null> {
  const db = drizzle(client);
  const rows = await db
    .update(deliveryAttempts)
    .set({
      status: "sent",
      providerMessageId: params.providerMessageId,
      sentAt: new Date(),
      // G8: frozen at send time — a later rate-card update never rewrites this row.
      costMicrosAtSend: params.costMicrosAtSend ?? null,
    })
    .where(eq(deliveryAttempts.id, params.id))
    .returning();
  return rows[0] ?? null;
}

export async function markDeliveryAttemptFailed(
  client: PgClient,
  params: { id: string; errorCode: string },
): Promise<DeliveryAttempt | null> {
  const db = drizzle(client);
  const rows = await db
    .update(deliveryAttempts)
    .set({ status: "failed", errorCode: params.errorCode, failedAt: new Date() })
    .where(eq(deliveryAttempts.id, params.id))
    .returning();
  return rows[0] ?? null;
}

/**
 * The three transitions out of `sent` all share one shape: atomic conditional UPDATE
 * guarded on `status = 'sent'`. A "delivered" webhook, a "delivery-failed" webhook, and
 * a fallback timer firing can all arrive for the same attempt in any order (T7, T8) —
 * whichever reaches Postgres first wins the row and the others' WHERE clause matches
 * zero rows, which every caller here treats as a no-op, not an error (R4.3/I9).
 */
export async function markDeliveryAttemptDelivered(
  client: PgClient,
  params: { id: string },
): Promise<DeliveryAttempt | null> {
  const db = drizzle(client);
  const rows = await db
    .update(deliveryAttempts)
    .set({ status: "delivered", deliveredAt: new Date() })
    .where(and(eq(deliveryAttempts.id, params.id), eq(deliveryAttempts.status, "sent")))
    .returning();
  return rows[0] ?? null;
}

export async function markDeliveryAttemptFailedFromSent(
  client: PgClient,
  params: { id: string; errorCode: string },
): Promise<DeliveryAttempt | null> {
  const db = drizzle(client);
  const rows = await db
    .update(deliveryAttempts)
    .set({ status: "failed", errorCode: params.errorCode, failedAt: new Date() })
    .where(and(eq(deliveryAttempts.id, params.id), eq(deliveryAttempts.status, "sent")))
    .returning();
  return rows[0] ?? null;
}

export async function markDeliveryAttemptTimedOut(
  client: PgClient,
  params: { id: string },
): Promise<DeliveryAttempt | null> {
  const db = drizzle(client);
  const rows = await db
    .update(deliveryAttempts)
    .set({ status: "timed_out", timeoutAt: new Date() })
    .where(and(eq(deliveryAttempts.id, params.id), eq(deliveryAttempts.status, "sent")))
    .returning();
  return rows[0] ?? null;
}
