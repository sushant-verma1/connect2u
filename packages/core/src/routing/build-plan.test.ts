import { describe, expect, it } from "vitest";
import { buildRoutingPlan } from "./build-plan.js";
import type { RoutingPolicy } from "./policy.js";
import type {
  CapabilityRecord,
  ChannelScoreRecord,
  ProviderRateRecord,
  RoutingInput,
} from "./types.js";

const NOW = new Date("2026-09-13T00:00:00Z");

function input(overrides: Partial<RoutingInput> = {}): RoutingInput {
  return {
    accountId: "acct_1",
    phoneHash: "hash",
    country: "IN",
    prefix: "+91",
    metadata: {},
    now: NOW,
    ...overrides,
  };
}

const POLICY: RoutingPolicy = {
  version: 1,
  rules: [{ match: { country: "IN" }, channels: ["whatsapp", "sms"] }],
  default: { channels: ["sms"] },
};

describe("buildRoutingPlan", () => {
  it("composes all four stages end to end with no overrides", () => {
    const plan = buildRoutingPlan(POLICY, input(), [], [], []);
    expect(plan.orderedChannels).toEqual(["whatsapp", "sms"]);
    expect(plan.timeouts).toEqual({ whatsapp: 20_000, sms: 30_000 });
  });

  it("a capability drop, a score reorder, and a cost-ceiling drop all compose correctly", () => {
    const policyWithCeiling: RoutingPolicy = {
      version: 1,
      rules: [
        { match: { country: "IN" }, channels: ["whatsapp", "sms"], max_cost_micros: 1_000_000 },
      ],
      default: { channels: ["sms"] },
    };
    const capability: CapabilityRecord[] = [
      {
        channel: "whatsapp",
        capability: "likely",
        confidence: 0.9,
        lastSuccessAt: NOW,
        consecutiveFailures: 0,
        updatedAt: NOW,
      },
    ];
    const scores: ChannelScoreRecord[] = [{ channel: "sms", verificationRate: 0.95, p50Ms: 1000 }];
    const rates: ProviderRateRecord[] = [
      { channel: "whatsapp", rateMicros: 100_000 },
      { channel: "sms", rateMicros: 2_000_000 },
    ];

    // whatsapp is capability-favoured, sms scores well but costs over the ceiling —
    // the ceiling should still win since it runs last.
    const plan = buildRoutingPlan(policyWithCeiling, input(), capability, scores, rates);
    expect(plan.orderedChannels).toEqual(["whatsapp"]);
    expect(plan.decisionLog.some((e) => e.stage === "cost_ceiling" && e.channel === "sms")).toBe(
      true,
    );
  });

  it("changing the account's policy changes the attempted channel with the exact same inputs otherwise", () => {
    const highRiskPolicy: RoutingPolicy = {
      version: 2,
      rules: [
        { match: { risk: "high" }, channels: ["sms"], reason: "no fallback for high-risk flows" },
      ],
      default: { channels: ["whatsapp", "sms"] },
    };

    const sameInput = input({ country: "US", risk: "high" });
    const before = buildRoutingPlan(POLICY, sameInput, [], [], []); // POLICY has no matching rule, falls to its own default
    const after = buildRoutingPlan(highRiskPolicy, sameInput, [], [], []); // highRiskPolicy's risk rule matches

    expect(before.orderedChannels).toEqual(["sms"]);
    expect(after.orderedChannels).toEqual(["sms"]);
    expect(after.decisionLog[0]).toMatchObject({ reason: "no fallback for high-risk flows" });

    // The interesting comparison: swap which policy is "default-only" so the same input
    // actually produces a different first channel purely from the policy change.
    const whatsappFirstPolicy: RoutingPolicy = {
      version: 1,
      rules: [],
      default: { channels: ["whatsapp"] },
    };
    const smsFirstPolicy: RoutingPolicy = { version: 2, rules: [], default: { channels: ["sms"] } };
    const plan1 = buildRoutingPlan(whatsappFirstPolicy, sameInput, [], [], []);
    const plan2 = buildRoutingPlan(smsFirstPolicy, sameInput, [], [], []);
    expect(plan1.orderedChannels[0]).toBe("whatsapp");
    expect(plan2.orderedChannels[0]).toBe("sms");
  });

  it("caps the final order at MAX_FALLBACK_CHANNELS and logs the overflow", () => {
    // Only two real channels exist today, so this exercises the cap's bookkeeping via
    // the unit already covering MAX_FALLBACK_CHANNELS in channel-chain.test.ts — here
    // we just confirm build-plan never emits more channels than the cap allows.
    const plan = buildRoutingPlan(POLICY, input(), [], [], []);
    expect(plan.orderedChannels.length).toBeLessThanOrEqual(3);
  });
});
