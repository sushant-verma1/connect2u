import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { isChannel } from "@otp-router/core/fallback/channel-chain";
import type { CapabilityRecord } from "@otp-router/core/routing/types";
import type { PgClient } from "../client.js";
import { channelCapability } from "../schema.js";

function isCapabilityValue(value: string): value is CapabilityRecord["capability"] {
  return value === "unknown" || value === "likely" || value === "unlikely";
}

function toCapabilityRecord(row: typeof channelCapability.$inferSelect): CapabilityRecord | null {
  if (!isChannel(row.channel) || !isCapabilityValue(row.capability)) {
    return null;
  }
  return {
    channel: row.channel,
    capability: row.capability,
    confidence: row.confidence,
    lastSuccessAt: row.lastSuccessAt,
    consecutiveFailures: row.consecutiveFailures,
    updatedAt: row.updatedAt,
  };
}

/** R3.5: keyed on phone_hash, never plaintext — every channel this number has ever
 * been tried on, for filter-by-capability.ts to weigh. */
export async function findCapabilityByPhoneHash(
  client: PgClient,
  phoneHash: string,
): Promise<readonly CapabilityRecord[]> {
  const db = drizzle(client);
  const rows = await db
    .select()
    .from(channelCapability)
    .where(eq(channelCapability.phoneHash, phoneHash));
  return rows
    .map(toCapabilityRecord)
    .filter((record): record is CapabilityRecord => record !== null);
}

/** R3.6: written after every delivery outcome resolves — `record` is already the
 * post-`applyDeliveryOutcome` value; this just persists it. */
export async function upsertCapability(
  client: PgClient,
  phoneHash: string,
  record: CapabilityRecord,
): Promise<void> {
  const db = drizzle(client);
  await db
    .insert(channelCapability)
    .values({
      phoneHash,
      channel: record.channel,
      capability: record.capability,
      confidence: record.confidence,
      lastSuccessAt: record.lastSuccessAt,
      consecutiveFailures: record.consecutiveFailures,
      updatedAt: record.updatedAt,
    })
    .onConflictDoUpdate({
      target: [channelCapability.phoneHash, channelCapability.channel],
      set: {
        capability: record.capability,
        confidence: record.confidence,
        lastSuccessAt: record.lastSuccessAt,
        consecutiveFailures: record.consecutiveFailures,
        updatedAt: record.updatedAt,
      },
    });
}
