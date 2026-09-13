import type { CandidateChannel, DecisionLogEntry, ProviderRateRecord } from "./types.js";

export type ApplyCostCeilingResult = Readonly<{
  candidates: readonly CandidateChannel[];
  decisionLog: readonly DecisionLogEntry[];
}>;

/**
 * R3.10: stage ④ — drops any channel whose rate exceeds the policy's cost ceiling, with
 * the exclusion logged (not just silently dropped). No ceiling means no filtering.
 *
 * A channel with no rate on file fails closed — it is dropped, not kept. Treating an
 * unknown cost as "passes" would invert the ceiling's purpose: the one corridor missing
 * a `provider_rates` row would sail through regardless of what it actually costs, while
 * a correctly-priced-but-expensive channel gets excluded. A cost ceiling is a spend
 * control (R7.5-adjacent); unknown cost must be the conservative case, not the lucky one.
 */
export function applyCostCeiling(
  candidates: readonly CandidateChannel[],
  rates: readonly ProviderRateRecord[],
  ceilingMicros: number | undefined,
): ApplyCostCeilingResult {
  if (ceilingMicros === undefined) {
    return { candidates, decisionLog: [] };
  }

  const byChannel = new Map(rates.map((rate) => [rate.channel, rate]));
  const decisionLog: DecisionLogEntry[] = [];

  const kept = candidates.filter((candidate) => {
    const rate = byChannel.get(candidate.channel);
    if (!rate) {
      decisionLog.push({
        stage: "cost_ceiling",
        action: "skipped",
        channel: candidate.channel,
        reason: `no rate on file to check against cost ceiling ${ceilingMicros} micros — failing closed`,
      });
      return false;
    }
    if (rate.rateMicros > ceilingMicros) {
      decisionLog.push({
        stage: "cost_ceiling",
        action: "skipped",
        channel: candidate.channel,
        reason: `rate ${rate.rateMicros} micros exceeds cost ceiling ${ceilingMicros} micros`,
      });
      return false;
    }
    return true;
  });

  return { candidates: kept, decisionLog };
}
