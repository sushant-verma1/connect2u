import type { Channel } from "../fallback/channel-chain.js";

// ARCHITECTURE.md §5's RoutingInput, extended with the fields R3.2's match criteria
// actually need (prefix, risk) and `now` (I1: packages/core never reads the clock
// itself — every stage that needs "now" for age-based decay gets it from here).
export type RoutingInput = Readonly<{
  accountId: string;
  phoneHash: string;
  country: string;
  prefix: string;
  risk?: string;
  metadata: Readonly<Record<string, string>>;
  requestedChannels?: readonly Channel[];
  now: Date;
}>;

export type DecisionStage = "match_policy" | "capability_filter" | "score_rank" | "cost_ceiling";
export type DecisionAction = "considered" | "skipped" | "reordered" | "chosen";

// R3.9: every decision persists the channels considered, the one chosen, and the
// reason for every skip — this is the whole entry, stage by stage, appended to as the
// pipeline runs, then persisted whole as `routing_decisions.decision_log_json`.
export type DecisionLogEntry = Readonly<{
  stage: DecisionStage;
  action: DecisionAction;
  channel?: Channel;
  reason: string;
}>;

export type CandidateChannel = Readonly<{
  channel: Channel;
  timeoutMs: number;
}>;

export type RoutingPlan = Readonly<{
  orderedChannels: readonly Channel[];
  // Only ever has entries for channels actually in `orderedChannels` — a channel
  // dropped by an earlier stage never gets a timeout entry.
  timeouts: Readonly<Partial<Record<Channel, number>>>;
  decisionLog: readonly DecisionLogEntry[];
}>;

// R3.5/R3.6: keyed on phone_hash by the caller — capability-filter.ts only ever sees
// the records for one phone_hash's known channels, never plaintext.
export type CapabilityRecord = Readonly<{
  channel: Channel;
  capability: "unknown" | "likely" | "unlikely";
  confidence: number; // 0..1
  lastSuccessAt: Date | null;
  consecutiveFailures: number;
  updatedAt: Date;
}>;

// R3.7: precomputed by the score-recompute job, scoped by the caller to the routing
// input's country before rank-by-score.ts ever sees it — verification rate, not
// delivery rate.
export type ChannelScoreRecord = Readonly<{
  channel: Channel;
  verificationRate: number; // 0..1
  p50Ms: number | null; // null when the window verified nothing on this channel
}>;

export type ProviderRateRecord = Readonly<{
  channel: Channel;
  rateMicros: number;
}>;
