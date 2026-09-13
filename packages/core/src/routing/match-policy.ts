import { CHANNEL_TIMEOUT_MS, isChannel } from "../fallback/channel-chain.js";
import type { PolicyRule, RoutingPolicy, RuleOutcome } from "./policy.js";
import type { CandidateChannel, DecisionLogEntry, RoutingInput } from "./types.js";

/** R3.2: every match key present on the rule must match the input; an absent key is a
 * wildcard. `prefix` is a startsWith check (a policy prefix like "+1" should match every
 * number under it); everything else is exact. */
function ruleMatches(rule: PolicyRule, input: RoutingInput): boolean {
  const { match } = rule;
  if (match.country !== undefined && match.country !== input.country) return false;
  if (match.prefix !== undefined && !input.prefix.startsWith(match.prefix)) return false;
  if (match.risk !== undefined && match.risk !== input.risk) return false;
  if (match.metadata) {
    for (const [key, value] of Object.entries(match.metadata)) {
      if (input.metadata[key] !== value) return false;
    }
  }
  return true;
}

export type MatchPolicyResult = Readonly<{
  candidates: readonly CandidateChannel[];
  costCeilingMicros: number | undefined;
  decisionLog: readonly DecisionLogEntry[];
}>;

/** R3.2/R3.4/R4.5: stage ① — the first rule that matches wins; falling through to
 * `policy.default` if none do. Per-channel timeouts come from the matched rule/default,
 * only falling back to the fixed `CHANNEL_TIMEOUT_MS` constant when the policy itself
 * doesn't specify one for that channel. */
export function matchPolicy(policy: RoutingPolicy, input: RoutingInput): MatchPolicyResult {
  const matchedRule = policy.rules.find((rule) => ruleMatches(rule, input));
  const outcome: RuleOutcome = matchedRule ?? policy.default;
  const matchReason = matchedRule
    ? (matchedRule.reason ?? `matched rule with channels [${matchedRule.channels.join(", ")}]`)
    : (policy.default.reason ?? "no rule matched — using default");

  const requested = input.requestedChannels;
  const channels =
    requested && requested.length > 0
      ? outcome.channels.filter((channel) => requested.includes(channel))
      : outcome.channels;

  const candidates: CandidateChannel[] = channels.filter(isChannel).map((channel) => ({
    channel,
    timeoutMs: outcome.timeouts_ms?.[channel] ?? CHANNEL_TIMEOUT_MS[channel],
  }));

  const decisionLog: DecisionLogEntry[] = [
    { stage: "match_policy", action: "chosen", reason: matchReason },
    ...candidates.map((candidate): DecisionLogEntry => ({
      stage: "match_policy",
      action: "considered",
      channel: candidate.channel,
      reason: matchReason,
    })),
  ];

  return { candidates, costCeilingMicros: outcome.max_cost_micros, decisionLog };
}
