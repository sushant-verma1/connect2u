import type { Channel } from "@otp-router/core/fallback/channel-chain";
import type { RoutingPolicy } from "@otp-router/core/routing/policy";
import type { ProviderError } from "@otp-router/providers/provider";
import type { PopulationConfig } from "./population.js";

// The in-memory scenario shape the runner actually consumes. scenario-schema.ts is the
// on-disk YAML format (R9.1) and validates into this shape — this file stays the
// runner's internal contract so that layer can change without touching runner.ts.
export type ChannelProviderConfig = Readonly<{
  failureRate: number;
  failureCode: ProviderError["code"];
  /** R9.1 latency distribution: mean of an exponential draw for provider/network send
   * latency, in ms. Separate from population.ts's meanResponseDelayMs — this is time
   * for the message to arrive, not time for the person to act on it. Defaults to 0. */
  meanLatencyMs?: number;
  /** R9.1 webhook chaos: probability that a send which actually succeeded never
   * produces a delivery confirmation the router can see — the real failure mode behind
   * G1's "delivered but never counted." Defaults to 0. */
  webhookChaosRate?: number;
  /** R9.1 late-delivery probability: fraction of latency draws that use
   * `meanLatencyMs + lateDeliveryExtraMs` instead of `meanLatencyMs` — a carrier-side
   * slowdown distinct from ordinary jitter. Defaults to 0. */
  lateDeliveryRate?: number;
  lateDeliveryExtraMs?: number;
  /**
   * R9.5/G8: what this channel actually costs per accepted send, in micros —
   * `provider_rates.rate_micros`'s own unit (see apps/api/src/scripts/seed-provider-rates.ts
   * for real India-corridor values: WhatsApp 115,000, SMS 150,000). Charged once
   * `provider.send` resolves, exactly like `markDeliveryAttemptSent`'s
   * `cost_micros_at_send` — never for a hard send failure, and never contingent on
   * whether a webhook or a verification ever follows. Omitted (unpriced corridor) means
   * unknown, not free — see report.ts's handling of `costPerVerifiedMicros`.
   */
  rateMicros?: number;
}>;

export type ScenarioConfig = Readonly<{
  seed: number;
  verifications: number;
  arrivalIntervalMs: number;
  policy?: RoutingPolicy;
  population: PopulationConfig;
  providers: Readonly<{ whatsapp: ChannelProviderConfig; sms: ChannelProviderConfig }>;
  /**
   * G3 cold-start: when set, phone numbers cycle through a pool of this size instead of
   * every verification getting a fresh one, so the same synthetic user is seen again
   * and the router's capability cache (packages/core/src/routing/capability-update.ts)
   * has repeat evidence to warm on. Omitted or 0 means every verification is a stranger
   * — today's behaviour, and the right default for india-mixed/whatsapp-degraded, which
   * are about steady-state traffic, not repeat-visit learning.
   */
  uniquePhoneNumbers?: number;
  /**
   * Isolates G3's per-phone-hash capability cache from R3.7/R3.8's global outcome
   * scoring: when true, `buildRoutingPlan` still gets live capability records but
   * always sees an empty score history, so a preset built to demonstrate capability
   * warm-up (cold-start) isn't swamped by the country-wide score-rank stage reordering
   * everyone onto the better-performing channel within the first few hundred
   * verifications, before the per-number effect has a chance to show up.
   */
  disableScoreRanking?: boolean;
  /**
   * A/B baseline arm: when set, every verification tries exactly this channel order
   * with no capability filtering and no outcome-score ranking — a hardcoded chain that
   * never learns, standing in for "WhatsApp-first, fixed" as the thing outcome-scored
   * routing (the engine path, `fixedChain` unset) is measured against. `policy` is
   * ignored when this is set.
   */
  fixedChain?: readonly Channel[];
}>;
