import { describe, expect, it } from "vitest";
import { matchPolicy } from "./match-policy.js";
import type { RoutingPolicy } from "./policy.js";
import type { RoutingInput } from "./types.js";

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

// REQUIREMENTS.md §3's example policy, verbatim.
const EXAMPLE_POLICY: RoutingPolicy = {
  version: 3,
  rules: [
    {
      match: { country: "IN" },
      channels: ["whatsapp", "sms"],
      timeouts_ms: { whatsapp: 20_000, sms: 30_000 },
      max_cost_micros: 5000,
    },
    {
      match: { risk: "high" },
      channels: ["sms"],
      reason: "no fallback for high-risk flows",
    },
  ],
  default: { channels: ["sms"] },
};

describe("matchPolicy", () => {
  it("matches the first rule whose criteria all hold", () => {
    const result = matchPolicy(EXAMPLE_POLICY, input({ country: "IN" }));
    expect(result.candidates.map((c) => c.channel)).toEqual(["whatsapp", "sms"]);
    expect(result.candidates.map((c) => c.timeoutMs)).toEqual([20_000, 30_000]);
    expect(result.costCeilingMicros).toBe(5000);
  });

  it("falls through to the next rule when an earlier one doesn't match", () => {
    const result = matchPolicy(EXAMPLE_POLICY, input({ country: "US", risk: "high" }));
    expect(result.candidates.map((c) => c.channel)).toEqual(["sms"]);
  });

  it("falls through to the policy default when no rule matches", () => {
    const result = matchPolicy(EXAMPLE_POLICY, input({ country: "US", risk: "low" }));
    expect(result.candidates.map((c) => c.channel)).toEqual(["sms"]);
    expect(result.costCeilingMicros).toBeUndefined();
  });

  it("falls back to CHANNEL_TIMEOUT_MS when a rule doesn't specify a timeout", () => {
    const policy: RoutingPolicy = { version: 1, rules: [], default: { channels: ["whatsapp"] } };
    const result = matchPolicy(policy, input());
    expect(result.candidates).toEqual([{ channel: "whatsapp", timeoutMs: 20_000 }]);
  });

  it("matches on metadata: every key in the rule must equal the input", () => {
    const policy: RoutingPolicy = {
      version: 1,
      rules: [{ match: { metadata: { flow: "login" } }, channels: ["sms"] }],
      default: { channels: ["whatsapp"] },
    };
    expect(matchPolicy(policy, input({ metadata: { flow: "login" } })).candidates[0]?.channel).toBe(
      "sms",
    );
    expect(
      matchPolicy(policy, input({ metadata: { flow: "signup" } })).candidates[0]?.channel,
    ).toBe("whatsapp");
  });

  it("matches on prefix as startsWith, not exact equality", () => {
    const policy: RoutingPolicy = {
      version: 1,
      rules: [{ match: { prefix: "+1" }, channels: ["sms"] }],
      default: { channels: ["whatsapp"] },
    };
    expect(matchPolicy(policy, input({ prefix: "+14155552671" })).candidates[0]?.channel).toBe(
      "sms",
    );
    expect(matchPolicy(policy, input({ prefix: "+919876543210" })).candidates[0]?.channel).toBe(
      "whatsapp",
    );
  });

  it("restricts the matched rule's channels to requestedChannels when the customer supplied one", () => {
    const result = matchPolicy(
      EXAMPLE_POLICY,
      input({ country: "IN", requestedChannels: ["sms"] }),
    );
    expect(result.candidates.map((c) => c.channel)).toEqual(["sms"]);
  });

  it("logs which rule matched and every channel it considered", () => {
    const result = matchPolicy(EXAMPLE_POLICY, input({ country: "IN" }));
    expect(result.decisionLog[0]).toMatchObject({ stage: "match_policy", action: "chosen" });
    expect(result.decisionLog.filter((e) => e.action === "considered")).toHaveLength(2);
  });
});
