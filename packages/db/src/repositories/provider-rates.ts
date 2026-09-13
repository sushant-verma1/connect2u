import { and, desc, eq, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PgClient } from "../client.js";
import { providerRates } from "../schema.js";

export type ProviderRate = typeof providerRates.$inferSelect;
export type NewProviderRate = typeof providerRates.$inferInsert;

export async function insertProviderRate(
  client: PgClient,
  data: NewProviderRate,
): Promise<ProviderRate> {
  const db = drizzle(client);
  const rows = await db.insert(providerRates).values(data).returning();
  const inserted = rows[0];
  if (!inserted) {
    throw new Error("provider rate insert returned no row");
  }
  return inserted;
}

/**
 * G8: the rate in effect *at send time* — the most recent row whose `effective_from`
 * has already passed. A rate-card update never rewrites what an already-sent attempt
 * cost; it only changes what the next lookup returns.
 */
export async function findApplicableRate(
  client: PgClient,
  params: { provider: string; channel: string; country: string; messageType: string },
): Promise<ProviderRate | null> {
  const db = drizzle(client);
  const rows = await db
    .select()
    .from(providerRates)
    .where(
      and(
        eq(providerRates.provider, params.provider),
        eq(providerRates.channel, params.channel),
        eq(providerRates.country, params.country),
        eq(providerRates.messageType, params.messageType),
        lte(providerRates.effectiveFrom, new Date()),
      ),
    )
    .orderBy(desc(providerRates.effectiveFrom))
    .limit(1);
  return rows[0] ?? null;
}
