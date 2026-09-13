import { describe, expect, it } from "vitest";
import { compareScenarios } from "./ab.js";
import { loadPreset } from "./scenario-loader.js";

describe("compareScenarios — R9.7 A/B mode", () => {
  it("runs both arms against identical traffic and reports a delta", async () => {
    const comparison = await compareScenarios(loadPreset("india-mixed"), {
      fixedChain: ["whatsapp", "sms"],
    });

    expect(comparison.a.seed).toBe(comparison.b.seed);
    expect(comparison.a.verifications).toBe(comparison.b.verifications);
    expect(comparison.delta.verificationRate).toBeCloseTo(
      comparison.b.verificationRate - comparison.a.verificationRate,
      10,
    );
  });

  it("outcome-scored routing vs a fixed WhatsApp-first chain on india-mixed: the honest result", async () => {
    const comparison = await compareScenarios(loadPreset("india-mixed"), {
      fixedChain: ["whatsapp", "sms"],
    });

    // The headline metric — whether a verification succeeds at all — is nearly a
    // wash: WhatsApp-first still reaches SMS as a fallback for the numbers it can't
    // deliver to. Recording that plainly here rather than asserting a large gap that
    // isn't there.
    expect(Math.abs(comparison.delta.verificationRate)).toBeLessThan(0.01);

    // What the fixed chain actually costs is time and wasted attempts: it spends
    // every unreachable-on-WhatsApp verification's first attempt on the channel that
    // was never going to work, where outcome-scored routing has already learned to
    // go straight to SMS. That shows up as a materially higher fallback rate and
    // slower p50/p95 for the fixed arm, not as a verification-rate win.
    expect(comparison.delta.fallbackRate).toBeGreaterThan(0.15);
    expect(comparison.delta.timeToVerifyMsP50).not.toBeNull();
    expect(comparison.delta.timeToVerifyMsP50 ?? 0).toBeGreaterThan(500);

    // R9.5/G8: the metric this whole project is pitched on. The fixed chain pays for
    // the wasted WhatsApp send *and* pays again for SMS, on every one of those extra
    // fallbacks — but WhatsApp is the cheaper channel in this rate card (115,000 vs
    // 150,000 micros), so the wasted send itself is cheap. The result is a real,
    // positive cost delta, but a modest one (measured: ~1 paisa, ~6% of cost/verified)
    // — smaller than the 27pp fallback-rate delta alone would suggest. Reporting the
    // actual size rather than a rounder-looking assumed one.
    expect(comparison.delta.costPerVerifiedMicros).not.toBeNull();
    expect(comparison.delta.costPerVerifiedMicros ?? 0).toBeGreaterThan(0);
    expect(comparison.delta.costPerVerifiedMicros ?? 0).toBeLessThan(20_000);
  });
});
