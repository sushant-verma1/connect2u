import { MAX_FALLBACK_CHANNELS, type Channel } from "../fallback/channel-chain.js";
import { applyCostCeiling } from "./apply-cost-ceiling.js";
import { filterByCapability } from "./filter-by-capability.js";
import type { RoutingPolicy } from "./policy.js";
import { matchPolicy } from "./match-policy.js";
import { rankByScore } from "./rank-by-score.js";
import type {
  CapabilityRecord,
  ChannelScoreRecord,
  DecisionLogEntry,
  ProviderRateRecord,
  RoutingInput,
  RoutingPlan,
} from "./types.js";

/**
 * R3.4: composes the four independently-testable pure stages — match → capability
 * filter → score rank → cost ceiling — into the plan `/v1/verification/start` actually
 * executes. R4.7's chain cap applies last, after routing has already ordered every
 * candidate by preference, so capping never discards a better channel in favour of a
 * worse one that merely came first in the raw list.
 */
export function buildRoutingPlan(
  policy: RoutingPolicy,
  input: RoutingInput,
  capabilityRecords: readonly CapabilityRecord[],
  channelScores: readonly ChannelScoreRecord[],
  rates: readonly ProviderRateRecord[],
): RoutingPlan {
  const matched = matchPolicy(policy, input);
  const filtered = filterByCapability(matched.candidates, capabilityRecords, input.now);
  const ranked = rankByScore(filtered.candidates, channelScores);
  const costed = applyCostCeiling(ranked.candidates, rates, matched.costCeilingMicros);

  const capped = costed.candidates.slice(0, MAX_FALLBACK_CHANNELS);
  const droppedByCapLog: DecisionLogEntry[] = costed.candidates
    .slice(MAX_FALLBACK_CHANNELS)
    .map((candidate) => ({
      stage: "cost_ceiling" as const,
      action: "skipped" as const,
      channel: candidate.channel,
      reason: `chain already at MAX_FALLBACK_CHANNELS (${MAX_FALLBACK_CHANNELS})`,
    }));

  const chosenLog: DecisionLogEntry[] = capped[0]
    ? [
        {
          stage: "score_rank",
          action: "chosen",
          channel: capped[0].channel,
          reason: "first in final order",
        },
      ]
    : [];

  const timeouts: Partial<Record<Channel, number>> = {};
  for (const candidate of capped) {
    timeouts[candidate.channel] = candidate.timeoutMs;
  }

  return {
    orderedChannels: capped.map((candidate) => candidate.channel),
    timeouts,
    decisionLog: [
      ...matched.decisionLog,
      ...filtered.decisionLog,
      ...ranked.decisionLog,
      ...costed.decisionLog,
      ...droppedByCapLog,
      ...chosenLog,
    ],
  };
}
