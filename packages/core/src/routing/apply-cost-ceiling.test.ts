import { describe, expect, it } from "vitest";
import { applyCostCeiling } from "./apply-cost-ceiling.js";
import type { CandidateChannel, ProviderRateRecord } from "./types.js";

const CANDIDATES: CandidateChannel[] = [
  { channel: "whatsapp", timeoutMs: 20_000 },
  { channel: "sms", timeoutMs: 30_000 },
];

describe("applyCostCeiling", () => {
  it("passes every candidate through when there's no ceiling", () => {
    const result = applyCostCeiling(CANDIDATES, [], undefined);
    expect(result.candidates).toEqual(CANDIDATES);
    expect(result.decisionLog).toEqual([]);
  });

  it("drops a channel over budget and logs the exclusion (R3.10)", () => {
    const rates: ProviderRateRecord[] = [
      { channel: "whatsapp", rateMicros: 2_000_000 },
      { channel: "sms", rateMicros: 150_000 },
    ];
    const result = applyCostCeiling(CANDIDATES, rates, 1_000_000);
    expect(result.candidates.map((c) => c.channel)).toEqual(["sms"]);
    expect(result.decisionLog).toEqual([
      expect.objectContaining({ stage: "cost_ceiling", action: "skipped", channel: "whatsapp" }),
    ]);
  });

  it("fails closed on a channel with no rate on file, rather than assuming it passes", () => {
    const result = applyCostCeiling(CANDIDATES, [], 100);
    expect(result.candidates).toEqual([]);
    expect(result.decisionLog).toEqual([
      expect.objectContaining({ stage: "cost_ceiling", action: "skipped", channel: "whatsapp" }),
      expect.objectContaining({ stage: "cost_ceiling", action: "skipped", channel: "sms" }),
    ]);
  });

  it("an unpriced channel never survives a ceiling that a priced-but-expensive channel doesn't", () => {
    // The inversion this guards against: whatsapp has no rate on file, sms is priced
    // but over budget. Both must be dropped — the unpriced one must not be preferred
    // just because its cost happens to be unknown.
    const rates: ProviderRateRecord[] = [{ channel: "sms", rateMicros: 2_000_000 }];
    const result = applyCostCeiling(CANDIDATES, rates, 1_000_000);
    expect(result.candidates).toEqual([]);
  });
});
