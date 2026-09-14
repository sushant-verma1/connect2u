import type { Job } from "bullmq";
import type { Logger } from "pino";
import type { PgClient } from "@otp-router/db/client";
import {
  computeChannelStats,
  insertChannelScores,
} from "@otp-router/db/repositories/channel-scores";
import type { ScoreRecomputeJobData } from "@otp-router/core/queue/score-recompute-job";

// A day of history is enough to react to a channel degrading without a single bad
// verification (a late webhook, a burst of timeouts) swinging the whole score.
const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * R3.7/R3.8: the only place `channel_scores` is written. Verification rate — not
 * delivery rate — per (channel, country); carrier_class stays "unknown" until carrier
 * detection exists (out of scope). Runs on a schedule (apps/worker/src/index.ts sets up
 * the repeat), never inside a request.
 */
export function createScoreRecomputeProcessor(pg: PgClient, logger: Logger) {
  return async function processScoreRecompute(_job: Job<ScoreRecomputeJobData>): Promise<void> {
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - WINDOW_MS);

    const stats = await computeChannelStats(pg, windowStart, windowEnd);
    const rows = stats
      .filter((stat) => stat.sends > 0)
      .map((stat, index) => ({
        id: `score_${windowEnd.getTime()}_${index}`,
        channel: stat.channel,
        country: stat.country,
        verificationRate: stat.verifications / stat.sends,
        // A window with sends but no verifications has no latency — null, never 0. A
        // rounded 0 is indistinguishable from "verified instantly" to the p50
        // tie-break in rank-by-score.ts (docs/findings/channel-attribution.md).
        p50Ms: stat.p50Ms === null ? null : Math.round(stat.p50Ms),
        p95Ms: stat.p95Ms === null ? null : Math.round(stat.p95Ms),
        windowStart,
        windowEnd,
      }));

    await insertChannelScores(pg, rows);
    logger.info(
      { windowStart, windowEnd, rows: rows.length },
      "score-recompute: wrote channel_scores",
    );
  };
}
