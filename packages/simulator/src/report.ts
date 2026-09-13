import type { ScenarioConfig } from "./scenario.js";
import type { VerificationResult } from "./runner.js";

// R9.5/R9.6: the machine-diffable half of the report. Field order is fixed by this
// object literal — T10's byte-identical-JSON requirement depends on that, not just on
// the numbers being equal.
export type Report = Readonly<{
  seed: number;
  verifications: number;
  verificationRate: number;
  deliveryRate: number;
  fallbackRate: number;
  timeToVerifyMsP50: number | null;
  timeToVerifyMsP95: number | null;
  channelDistribution: Readonly<Record<string, number>>;
  // R9.5/G8: total spend (every accepted send, converted or not) divided by the number
  // of verifications that actually succeeded — the metric G1 is built on: a channel
  // scored on delivery can send (and be charged) just as often as one scored on
  // verification, for a worse conversion outcome. `null` if any contributing
  // verification hit an unpriced corridor (see runner.ts) — an unknown total is
  // reported as unknown, not silently floored to a smaller, wrong number.
  costPerVerifiedMicros: number | null;
}>;

function percentile(sortedValues: readonly number[], p: number): number | null {
  if (sortedValues.length === 0) return null;
  const index = Math.floor(p * (sortedValues.length - 1));
  return sortedValues[index] ?? null;
}

export function buildReport(
  scenario: ScenarioConfig,
  results: readonly VerificationResult[],
): Report {
  const total = results.length;
  const verified = results.filter((r) => r.verified);
  const delivered = results.filter((r) => r.deliveredChannels.length > 0);
  const fellBack = results.filter((r) => r.channelsAttempted.length > 1);

  const times = verified
    .map((r) => r.timeToVerifyMs)
    .filter((ms): ms is number => ms !== null)
    .sort((a, b) => a - b);

  const channelDistribution: Record<string, number> = {};
  for (const result of verified) {
    if (result.channel) {
      channelDistribution[result.channel] = (channelDistribution[result.channel] ?? 0) + 1;
    }
  }

  const hasUnknownCost = results.some((r) => r.costMicros === null);
  const totalCostMicros = hasUnknownCost
    ? null
    : results.reduce((sum, r) => sum + (r.costMicros ?? 0), 0);
  const costPerVerifiedMicros =
    totalCostMicros === null || verified.length === 0 ? null : totalCostMicros / verified.length;

  return {
    seed: scenario.seed,
    verifications: total,
    verificationRate: total === 0 ? 0 : verified.length / total,
    deliveryRate: total === 0 ? 0 : delivered.length / total,
    fallbackRate: total === 0 ? 0 : fellBack.length / total,
    timeToVerifyMsP50: percentile(times, 0.5),
    timeToVerifyMsP95: percentile(times, 0.95),
    channelDistribution,
    costPerVerifiedMicros,
  };
}
