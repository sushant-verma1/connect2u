import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { isChannel, type Channel } from "@otp-router/core/fallback/channel-chain";
import type { ChannelScoreRecord } from "@otp-router/core/routing/types";
import type { PgClient } from "../client.js";
import { channelScores } from "../schema.js";

export type NewChannelScore = typeof channelScores.$inferInsert;

/** R3.8: written only by the score-recompute job — never at request time. */
export async function insertChannelScores(
  client: PgClient,
  rows: readonly NewChannelScore[],
): Promise<void> {
  if (rows.length === 0) return;
  const db = drizzle(client);
  await db.insert(channelScores).values([...rows]);
}

/** R3.7: the newest window per channel for this country — carrier_class is always
 * "unknown" until carrier detection exists (out of scope), so this reads the single
 * "unknown" bucket per channel rather than fanning out over a dimension nothing
 * populates yet. */
export async function findLatestScoresByCountry(
  client: PgClient,
  country: string,
): Promise<readonly ChannelScoreRecord[]> {
  const db = drizzle(client);
  const rows = await db
    .selectDistinctOn([channelScores.channel], {
      channel: channelScores.channel,
      verificationRate: channelScores.verificationRate,
      p50Ms: channelScores.p50Ms,
    })
    .from(channelScores)
    .where(eq(channelScores.country, country))
    .orderBy(channelScores.channel, desc(channelScores.windowEnd));

  const result: ChannelScoreRecord[] = [];
  for (const row of rows) {
    if (isChannel(row.channel)) {
      const channel: Channel = row.channel;
      result.push({ channel, verificationRate: row.verificationRate, p50Ms: row.p50Ms });
    }
  }
  return result;
}

export type AggregatedChannelStat = Readonly<{
  channel: string;
  country: string;
  sends: number;
  verifications: number;
  p50Ms: number | null;
  p95Ms: number | null;
}>;

/**
 * R3.7/R3.8: the score-recompute job's one query — verification rate (successful
 * `/check` within TTL, attributed to whichever channel `verified_channel` names ÷
 * sends on that channel), never delivery rate. `verified_channel` is a convention, not
 * a measurement — the last channel that delivered, since every channel carries the
 * same code and nothing observes which one the user read (the reasoning, and the bug
 * that made it a constant, are in apps/api/src/services/check-verification.ts and
 * docs/findings/channel-attribution.md). A verification with no attributable attempt
 * has `verified_channel = NULL` and is counted for no channel. `country` comes from
 * `delivery_attempts.country`, written at send time from the same two-bucket
 * classification G8's cost lookup already uses (apps/worker/src/processors/delivery.ts).
 * `windowStart`/`windowEnd` bound which attempts count.
 */
export async function computeChannelStats(
  client: PgClient,
  windowStart: Date,
  windowEnd: Date,
): Promise<readonly AggregatedChannelStat[]> {
  const rows = await client<AggregatedChannelStat[]>`
    SELECT
      da.channel AS channel,
      da.country AS country,
      COUNT(*)::int AS sends,
      COUNT(*) FILTER (
        WHERE v.status = 'verified' AND v.verified_channel = da.channel
      )::int AS verifications,
      PERCENTILE_CONT(0.5) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (v.verified_at - da.sent_at)) * 1000
      ) FILTER (WHERE v.status = 'verified' AND v.verified_channel = da.channel) AS "p50Ms",
      PERCENTILE_CONT(0.95) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (v.verified_at - da.sent_at)) * 1000
      ) FILTER (WHERE v.status = 'verified' AND v.verified_channel = da.channel) AS "p95Ms"
    FROM delivery_attempts da
    JOIN verifications v ON v.id = da.verification_id
    WHERE da.sent_at IS NOT NULL
      AND da.country IS NOT NULL
      AND da.sent_at >= ${windowStart}
      AND da.sent_at < ${windowEnd}
    GROUP BY da.channel, da.country
  `;
  return rows;
}
