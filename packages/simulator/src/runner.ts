import {
  CHANNEL_TIMEOUT_MS,
  nextChannel,
  type Channel,
} from "@otp-router/core/fallback/channel-chain";
import {
  applyDeliveryOutcome,
  initialCapabilityRecord,
} from "@otp-router/core/routing/capability-update";
import { DEFAULT_ROUTING_POLICY } from "@otp-router/core/routing/policy";
import { buildRoutingPlan } from "@otp-router/core/routing/build-plan";
import type { CapabilityRecord, RoutingInput, RoutingPlan } from "@otp-router/core/routing/types";
import { SimulatedProvider } from "@otp-router/providers/simulated";
import { VirtualClock } from "./clock.js";
import {
  drawProviderLatencyMs,
  drawResponseDelayMs,
  drawUser,
  isReachable,
  type SyntheticUser,
} from "./population.js";
import type { Prng } from "./prng.js";
import { createPrng } from "./prng.js";
import { buildReport, type Report } from "./report.js";
import { ScoreTracker } from "./score-tracker.js";
import type { ScenarioConfig } from "./scenario.js";

export type VerificationResult = Readonly<{
  verified: boolean;
  channel: string | null;
  timeToVerifyMs: number | null;
  channelsAttempted: readonly string[];
  // Channels where the send succeeded — the "delivery" side of G1's divergence. A
  // channel can appear here and never appear as `channel` on a verified result: sent
  // and reported delivered, but never actually used.
  deliveredChannels: readonly string[];
  // R9.5/G8: sum of every attempted channel's rateMicros where the send itself
  // succeeded — charged like markDeliveryAttemptSent's cost_micros_at_send, whether or
  // not that attempt ever converts. `null` means at least one such attempt used a
  // channel with no configured rate (an unpriced corridor) — treated as unknown, never
  // silently coerced to 0, which would under-count exactly like a NULL
  // cost_micros_at_send would in production.
  costMicros: number | null;
}>;

/** G3 cold start: applies a delivery outcome to whichever record (or freshly-initialised
 * default) this phone_hash already has for `channel`, returning the updated array —
 * this is the one place the simulator writes to the capability cache it reads via
 * `buildRoutingPlan`. */
function withCapabilityOutcome(
  records: readonly CapabilityRecord[],
  channel: Channel,
  outcome: "success" | "failure",
  now: Date,
): readonly CapabilityRecord[] {
  const existing =
    records.find((record) => record.channel === channel) ?? initialCapabilityRecord(channel, now);
  const updated = applyDeliveryOutcome(existing, outcome, now);
  return [...records.filter((record) => record.channel !== channel), updated];
}

/** A/B baseline arm (`scenario.fixedChain` set): the hardcoded order with no capability
 * filter and no score rank — the "WhatsApp-first, fixed" comparison point that never
 * adapts. The engine arm calls the real `buildRoutingPlan` instead. */
function planFor(
  scenario: ScenarioConfig,
  input: RoutingInput,
  capabilityRecords: readonly CapabilityRecord[],
  scores: ScoreTracker,
): RoutingPlan {
  if (scenario.fixedChain) {
    return { orderedChannels: scenario.fixedChain, timeouts: {}, decisionLog: [] };
  }
  const policy = scenario.policy ?? DEFAULT_ROUTING_POLICY;
  const channelScores = scenario.disableScoreRanking ? [] : scores.scores();
  return buildRoutingPlan(policy, input, capabilityRecords, channelScores, []);
}

/**
 * R9.2: drives the real routing engine — `buildRoutingPlan` imported straight from
 * `@otp-router/core/routing/build-plan`, the exact function `/v1/verification/start`
 * calls, not a reimplementation (bypassed only for the `fixedChain` baseline arm, which
 * is deliberately not the engine). Capability records and outcome scores are both
 * threaded in by the caller (`runScenario`'s `capabilityCache` and `ScoreTracker`) —
 * that's what lets a cold-start scenario's repeat visitors warm the cache, and what
 * makes outcome-scored routing actually diverge from a hardcoded chain.
 */
async function simulateVerification(
  scenario: ScenarioConfig,
  prng: Prng,
  clock: VirtualClock,
  phoneHash: string,
  user: SyntheticUser,
  capabilityRecords: readonly CapabilityRecord[],
  scores: ScoreTracker,
): Promise<{ result: VerificationResult; capabilityRecords: readonly CapabilityRecord[] }> {
  const now = new Date(clock.nowMs);
  const input: RoutingInput = {
    accountId: "sim",
    phoneHash,
    country: "IN",
    prefix: "+91",
    metadata: {},
    now,
  };
  const plan = planFor(scenario, input, capabilityRecords, scores);
  const learns = !scenario.fixedChain;

  const attempted: string[] = [];
  const delivered: string[] = [];
  let records = capabilityRecords;
  let elapsedMs = 0;
  let verifiedChannel: string | null = null;
  let timeToVerifyMs: number | null = null;
  let costMicros: number | null = 0;

  // R4.4/R4.7: the same `nextChannel` the worker's advanceOrFail uses to pick the next
  // untried channel from an ordered chain — not a hand-rolled loop over the array.
  let channel = nextChannel(plan.orderedChannels, attempted);
  while (channel && !verifiedChannel) {
    attempted.push(channel);
    const timeoutMs = plan.timeouts[channel] ?? CHANNEL_TIMEOUT_MS[channel];
    const providerConfig = scenario.providers[channel];

    // The real SimulatedProvider decides send success/failure and generates message
    // IDs — `latencyMs: 0` because wall-clock time never paces this simulation (R9.4);
    // network/provider latency is instead a virtual-clock quantity drawn below.
    // `random: prng` is what makes the provider's own coin-flip part of the one seeded
    // sequence (R9.3), not a second, untracked source of randomness.
    const provider = new SimulatedProvider({
      latencyMs: 0,
      failureRate: providerConfig.failureRate,
      failureCode: providerConfig.failureCode,
      random: prng,
    });

    try {
      // G3: a number this user's WhatsApp delivery genuinely can't reach — distinct
      // from G1's "delivered but unused" gap, and the only trait the capability cache
      // can actually see (see population.ts). Modelled as a guaranteed hard failure
      // rather than routed through the provider's own coin flip, so it stays a
      // deterministic, repeatable signal across the user's repeat visits.
      if (channel === "whatsapp" && user.whatsappBroken) {
        throw new Error("synthetic user cannot receive WhatsApp deliveries");
      }
      await provider.send({ phoneNumber: "+919876543210", code: "000000", channel });

      // R9.5/G8: charged on send success alone, before webhook chaos or response
      // timing get a say — matches production's markDeliveryAttemptSent.
      costMicros =
        costMicros === null || providerConfig.rateMicros === undefined
          ? null
          : costMicros + providerConfig.rateMicros;

      // R9.1 webhook chaos: the send itself succeeded, but the confirmation the router
      // relies on never arrives — from the system's point of view this is
      // indistinguishable from the channel not working at all.
      const webhookLost = prng() < (providerConfig.webhookChaosRate ?? 0);
      if (learns)
        records = withCapabilityOutcome(records, channel, webhookLost ? "failure" : "success", now);

      const latencyMs = drawProviderLatencyMs(
        prng,
        providerConfig.meanLatencyMs ?? 0,
        providerConfig.lateDeliveryRate ?? 0,
        providerConfig.lateDeliveryExtraMs ?? 0,
      );

      let verifiedOnThisChannel = false;
      if (!webhookLost) {
        delivered.push(channel);

        if (!user.abandonsEntirely && isReachable(user, channel)) {
          const responseDelayMs = drawResponseDelayMs(
            prng,
            scenario.population.meanResponseDelayMs[channel],
          );
          const totalDelayMs = latencyMs + responseDelayMs;
          if (totalDelayMs <= timeoutMs) {
            verifiedChannel = channel;
            timeToVerifyMs = elapsedMs + totalDelayMs;
            verifiedOnThisChannel = true;
          }
        }
      }
      if (learns)
        scores.record(
          channel,
          verifiedOnThisChannel,
          verifiedOnThisChannel ? timeToVerifyMs : null,
        );
      if (verifiedOnThisChannel) break;

      // Delivered (or not, if the webhook was lost), but not verified within this
      // channel's timeout — abandoned, unreachable, or simply too slow. The fallback
      // timer would have fired (R4.4 trigger #3): the full timeout elapses before the
      // chain advances.
      elapsedMs += timeoutMs;
    } catch {
      // Hard send failure (R4.4 trigger #1, or the synthetic whatsappBroken case above)
      // — advances immediately, no timeout wait.
      if (learns) {
        records = withCapabilityOutcome(records, channel, "failure", now);
        scores.record(channel, false, null);
      }
    }

    channel = nextChannel(plan.orderedChannels, attempted);
  }

  clock.advanceBy(scenario.arrivalIntervalMs);

  return {
    result: {
      verified: verifiedChannel !== null,
      channel: verifiedChannel,
      timeToVerifyMs,
      channelsAttempted: attempted,
      deliveredChannels: delivered,
      costMicros,
    },
    capabilityRecords: records,
  };
}

/** G3 cold start: `scenario.uniquePhoneNumbers` cycles verification `index` through a
 * fixed pool instead of minting a fresh number every time, so the same synthetic user
 * (and their capability cache entries) is revisited across the run. Omitted or 0 keeps
 * today's every-verification-is-a-stranger behaviour. */
function phoneHashForIndex(scenario: ScenarioConfig, index: number): string {
  const poolSize = scenario.uniquePhoneNumbers ?? 0;
  return poolSize > 0 ? `sim_${index % poolSize}` : `sim_${index}`;
}

export type ScenarioRun = Readonly<{
  report: Report;
  results: readonly VerificationResult[];
}>;

/** R9.3: one seeded PRNG, created once, threaded through every verification in arrival
 * order — the same seed reproduces the exact same sequence of draws every time.
 * Returns the raw per-verification results alongside the report so callers like the
 * cold-start preset can show capability-cache warm-up across the run without changing
 * `Report`'s byte-identical JSON shape (T10). */
export async function runScenarioDetailed(scenario: ScenarioConfig): Promise<ScenarioRun> {
  const prng = createPrng(scenario.seed);
  const clock = new VirtualClock();
  const scores = new ScoreTracker();

  const users = new Map<string, SyntheticUser>();
  const capabilityCache = new Map<string, readonly CapabilityRecord[]>();
  const results: VerificationResult[] = [];

  for (let i = 0; i < scenario.verifications; i++) {
    const phoneHash = phoneHashForIndex(scenario, i);

    // A returning synthetic user keeps the same underlying traits (reachability,
    // whether they abandon) on every visit — only their per-attempt response delay is
    // redrawn — otherwise "the same person" would be a different person each time.
    let user = users.get(phoneHash);
    if (!user) {
      user = drawUser(prng, scenario.population);
      users.set(phoneHash, user);
    }

    const { result, capabilityRecords } = await simulateVerification(
      scenario,
      prng,
      clock,
      phoneHash,
      user,
      capabilityCache.get(phoneHash) ?? [],
      scores,
    );
    capabilityCache.set(phoneHash, capabilityRecords);
    results.push(result);
  }

  return { report: buildReport(scenario, results), results };
}

export async function runScenario(scenario: ScenarioConfig): Promise<Report> {
  return (await runScenarioDetailed(scenario)).report;
}
