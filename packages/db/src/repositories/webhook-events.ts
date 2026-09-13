import { drizzle } from "drizzle-orm/postgres-js";
import type { PgClient } from "../client.js";
import { webhookEvents } from "../schema.js";

export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type NewWebhookEvent = typeof webhookEvents.$inferInsert;

/**
 * R6.2: the dedupe mechanism is the `webhook_events_dedupe_idx` unique index, not
 * application logic. Returns `null` on a duplicate (provider, provider_message_id)
 * instead of throwing — the caller (webhook-ingest processor) treats that as "already
 * processed," not an error.
 */
export async function insertWebhookEventIfNew(
  client: PgClient,
  data: NewWebhookEvent,
): Promise<WebhookEvent | null> {
  const db = drizzle(client);
  const rows = await db.insert(webhookEvents).values(data).onConflictDoNothing().returning();
  return rows[0] ?? null;
}
