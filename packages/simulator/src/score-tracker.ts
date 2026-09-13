import type { Channel } from "@otp-router/core/fallback/channel-chain";
import type { ChannelScoreRecord } from "@otp-router/core/routing/types";

type ChannelStats = { attempts: number; verified: number; times: number[] };

// ponytail: `scores()` is called once per verification and re-sorts `times` from
// scratch — a full run's history would make that O(n² log n) over the whole
// simulation. Capping the reservoir bounds the sort cost regardless of run length; it
// also mirrors a real score-recompute job, which works off a recent rolling window,
// not all-time history. Ceiling: revisit with a proper streaming quantile structure if
// p50 accuracy over the full window ever matters more than O(1) memory.
const LATENCY_RESERVOIR_SIZE = 500;

/**
 * R3.7/R3.8 stand-in for the score-recompute job: a running per-channel verification
 * rate and p50 time-to-verify, updated after every simulated verification and fed
 * straight into `buildRoutingPlan`'s score-rank stage. Without this, rank-by-score
 * always sees an empty history and every channel ties at the neutral score — which
 * would make "outcome-scored routing" indistinguishable from a hardcoded chain no
 * matter how the population behaves.
 */
export class ScoreTracker {
  private readonly stats = new Map<Channel, ChannelStats>();

  record(channel: Channel, verified: boolean, timeToVerifyMs: number | null): void {
    const entry = this.stats.get(channel) ?? { attempts: 0, verified: 0, times: [] };
    entry.attempts += 1;
    if (verified) {
      entry.verified += 1;
      if (timeToVerifyMs !== null) {
        entry.times.push(timeToVerifyMs);
        if (entry.times.length > LATENCY_RESERVOIR_SIZE) entry.times.shift();
      }
    }
    this.stats.set(channel, entry);
  }

  scores(): readonly ChannelScoreRecord[] {
    return [...this.stats.entries()].map(([channel, entry]) => {
      const sorted = [...entry.times].sort((a, b) => a - b);
      const p50 = sorted[Math.floor(sorted.length / 2)] ?? Number.POSITIVE_INFINITY;
      return {
        channel,
        verificationRate: entry.attempts > 0 ? entry.verified / entry.attempts : 0.5,
        p50Ms: p50,
      };
    });
  }
}
