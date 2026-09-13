import { describe, expect, it } from "vitest";
import { loadPreset } from "./scenario-loader.js";
import { runScenarioDetailed } from "./runner.js";

// R9.9: this file runs as part of the standard `pnpm test` that ci.yml already
// executes — a routing regression that moves these presets' numbers outside their
// recorded bands fails the build with no extra CI wiring needed.

describe("preset regression bands — R9.9", () => {
  it("india-mixed: outcome-scored routing on steady-state traffic", async () => {
    const { report } = await runScenarioDetailed(loadPreset("india-mixed"));
    expect(report.verificationRate).toBeGreaterThan(0.9);
    expect(report.deliveryRate).toBeGreaterThan(0.98);
    // Outcome-scored routing should have learned, well within 10k verifications, that
    // SMS out-verifies WhatsApp here (WhatsApp only reaches 72% of numbers at all) —
    // most verifications should already be landing on SMS, not the policy's nominal
    // WhatsApp-first order.
    expect(report.channelDistribution.sms ?? 0).toBeGreaterThan(
      report.channelDistribution.whatsapp ?? 0,
    );
    // R9.5/G8: both channels are priced in this preset, so cost/success must be a
    // known, positive number, not null (an unpriced corridor silently coerced to 0).
    expect(report.costPerVerifiedMicros).not.toBeNull();
    expect(report.costPerVerifiedMicros ?? 0).toBeGreaterThan(0);
  });

  it("whatsapp-degraded: routing still verifies most traffic despite WhatsApp's outage", async () => {
    const { report } = await runScenarioDetailed(loadPreset("whatsapp-degraded"));
    expect(report.verificationRate).toBeGreaterThan(0.85);
    // A degraded WhatsApp should be leaned on even less than in india-mixed.
    const indiaMixed = await runScenarioDetailed(loadPreset("india-mixed"));
    const degradedWhatsappShare = (report.channelDistribution.whatsapp ?? 0) / report.verifications;
    const mixedWhatsappShare =
      (indiaMixed.report.channelDistribution.whatsapp ?? 0) / indiaMixed.report.verifications;
    expect(degradedWhatsappShare).toBeLessThan(mixedWhatsappShare);
  });

  it("cold-start: the capability cache visibly warms up — Phase 6 exit gate", async () => {
    const { results } = await runScenarioDetailed(loadPreset("cold-start"));
    const half = Math.floor(results.length / 2);
    const firstHalf = results.slice(0, half);
    const secondHalf = results.slice(half);

    const fallbackRate = (rs: typeof results) =>
      rs.filter((r) => r.channelsAttempted.length > 1).length / rs.length;

    // 30% of this preset's 200 returning numbers can never actually receive a WhatsApp
    // delivery (whatsappBrokenShare). Early on, the capability cache has no evidence
    // yet, so those numbers still waste a first attempt on WhatsApp before falling
    // back to SMS — every one of those is counted as a "fallback". By the second half,
    // two failed attempts have dropped WhatsApp from their candidate list entirely
    // (filter-by-capability.ts), so the fallback rate should visibly fall (measured:
    // ~0.12 -> ~0.08, a little over 1/3 relative reduction).
    expect(fallbackRate(secondHalf)).toBeLessThan(fallbackRate(firstHalf) * 0.75);
  });
});
