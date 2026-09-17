import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PgClient } from "../client.js";
import { deliveryAttempts } from "../schema.js";

export type DeliveryAttempt = typeof deliveryAttempts.$inferSelect;
export type NewDeliveryAttempt = typeof deliveryAttempts.$inferInsert;

export type SpendSummary = Readonly<{ knownMicros: number; unpricedCount: number }>;

/**
 * R7.5/G8: today's spend for this account, split into what's known and how many sends
 * had no `cost_micros_at_send` at all — `packages/core/src/fraud/daily-spend.ts` is the
 * one place that decides what an unpriced send counts as, deliberately not here, so the
 * SQL stays a plain aggregate and never quietly folds a NULL into the SUM as a 0.
 * Scoped on `sent_at` (a send actually happened), not `status`, since status moves on
 * to delivered/failed/timed_out while `cost_micros_at_send` stays put.
 */
export async function sumTodaySpendForAccount(
  client: PgClient,
  accountId: string,
): Promise<SpendSummary> {
  const db = drizzle(client);
  const startOfDayUtc = new Date();
  startOfDayUtc.setUTCHours(0, 0, 0, 0);

  const rows = await db
    .select({
      knownMicros: sql<string>`coalesce(sum(${deliveryAttempts.costMicrosAtSend}), 0)`,
      unpricedCount: sql<string>`count(*) filter (where ${deliveryAttempts.costMicrosAtSend} is null)`,
    })
    .from(deliveryAttempts)
    .where(
      and(
        eq(deliveryAttempts.accountId, accountId),
        isNotNull(deliveryAttempts.sentAt),
        gte(deliveryAttempts.sentAt, startOfDayUtc),
      ),
    );

  const row = rows[0];
  return {
    knownMicros: Number(row?.knownMicros ?? 0),
    unpricedCount: Number(row?.unpricedCount ?? 0),
  };
}

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

/** R10.6: `id` is a ULID (`att_${ulid()}`) — lexicographically sortable by creation
 * time, so ordering by it gives the trace view chronological order with no separate
 * `created_at` column needed. */
export async function findDeliveryAttemptsByVerification(
  client: PgClient,
  verificationId: string,
): Promise<DeliveryAttempt[]> {
  const db = drizzle(client);
  return db
    .select()
    .from(deliveryAttempts)
    .where(eq(deliveryAttempts.verificationId, verificationId))
    .orderBy(deliveryAttempts.id);
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
  params: {
    id: string;
    providerMessageId: string;
    costMicrosAtSend?: number | null;
    country?: string | null;
    // Corrects the "simulated" placeholder the row was inserted with — the insert
    // happens before the worker knows which adapter will actually run this send.
    // Optional so this stays backward-compatible; omitting it leaves the placeholder.
    provider?: string;
  },
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
      // R3.7: what score-recompute groups on later — same classification as the cost lookup above.
      country: params.country ?? null,
      ...(params.provider !== undefined ? { provider: params.provider } : {}),
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
