import { describe, expect, it } from "vitest";
import { runScenario } from "./runner.js";
import type { ScenarioConfig } from "./scenario.js";

function scenario(overrides: Partial<ScenarioConfig> = {}): ScenarioConfig {
  return {
    seed: 42,
    verifications: 500,
    arrivalIntervalMs: 100,
    population: {
      whatsappReachableShare: 0.6,
      abandonRate: 0.05,
      meanResponseDelayMs: { whatsapp: 8000, sms: 6000 },
    },
    providers: {
      whatsapp: { failureRate: 0.02, failureCode: "provider_error" },
      sms: { failureRate: 0.01, failureCode: "provider_error" },
    },
    ...overrides,
  };
}

describe("runScenario — T10 reproducibility", () => {
  it("the same seed produces byte-identical JSON across independent runs", async () => {
    const reportA = await runScenario(scenario({ seed: 7 }));
    const reportB = await runScenario(scenario({ seed: 7 }));

    const jsonA = JSON.stringify(reportA);
    const jsonB = JSON.stringify(reportB);

    expect(jsonA).toBe(jsonB);
    // Sanity: this scenario actually produces varied outcomes, so an identical JSON
    // string is proof of determinism, not a trivial all-zeros/empty report.
    expect(reportA.verifications).toBe(500);
    expect(reportA.verificationRate).toBeGreaterThan(0);
    expect(reportA.verificationRate).toBeLessThan(1);
  });

  it("a different seed produces a different report — the seed is actually threaded, not incidental", async () => {
    const reportA = await runScenario(scenario({ seed: 7 }));
    const reportC = await runScenario(scenario({ seed: 1234 }));

    expect(JSON.stringify(reportA)).not.toBe(JSON.stringify(reportC));
  });

  it("running the same seed a third time still matches — not a one-off coincidence", async () => {
    const first = JSON.stringify(await runScenario(scenario({ seed: 99 })));
    const second = JSON.stringify(await runScenario(scenario({ seed: 99 })));
    const third = JSON.stringify(await runScenario(scenario({ seed: 99 })));
    expect(first).toBe(second);
    expect(second).toBe(third);
  });
});

describe("runScenario — population model produces verification/delivery divergence (G1)", () => {
  it("verification rate is well below delivery rate when WhatsApp reachability is low", async () => {
    // Single-channel policy (no SMS fallback) isolates the effect — with fallback
    // available, SMS quietly rescues most of the unreachable WhatsApp population,
    // which is real and correct behaviour but would hide the divergence this test is
    // checking for. Removing the escape hatch shows what WhatsApp alone actually does.
    const report = await runScenario(
      scenario({
        seed: 7,
        verifications: 2000,
        policy: { version: 1, rules: [], default: { channels: ["whatsapp"] } },
        population: {
          whatsappReachableShare: 0.3, // most of the population isn't actually on WhatsApp
          abandonRate: 0,
          meanResponseDelayMs: { whatsapp: 5000, sms: 5000 },
        },
        providers: {
          // Sends never fail — every attempt "delivers" (in the SimulatedProvider
          // sense) regardless of whether the synthetic user ever sees it.
          whatsapp: { failureRate: 0, failureCode: "provider_error" },
          sms: { failureRate: 0, failureCode: "provider_error" },
        },
      }),
    );

    // Every attempt delivers (no send failures), but 70% of the population is never
    // actually reachable on WhatsApp, so verification rate must land near 0.3, far
    // below delivery rate near 1.
    expect(report.deliveryRate).toBeGreaterThan(0.99);
    expect(report.verificationRate).toBeLessThan(report.deliveryRate - 0.5);
    expect(report.verificationRate).toBeCloseTo(0.3, 1);
  });

  it("fallback to SMS partially rescues unreachable-on-WhatsApp users, but a gap to delivery rate remains", async () => {
    // A fixed WhatsApp-then-SMS chain, not the default policy — this test is about
    // R4.4's fallback mechanic in isolation, not R3.7/R3.8 outcome-scored ranking.
    // Left on the live-scored default policy, the engine would (correctly) learn
    // within a few hundred verifications that SMS out-verifies WhatsApp here and
    // promote it to first position, which quietly erases the very fallback behaviour
    // this test exists to check — that self-correction is real and desirable, just not
    // what this particular test is isolating.
    const report = await runScenario(
      scenario({
        seed: 7,
        verifications: 2000,
        fixedChain: ["whatsapp", "sms"],
        population: {
          whatsappReachableShare: 0.3,
          abandonRate: 0,
          meanResponseDelayMs: { whatsapp: 5000, sms: 5000 },
        },
        providers: {
          whatsapp: { failureRate: 0, failureCode: "provider_error" },
          sms: { failureRate: 0, failureCode: "provider_error" },
        },
      }),
    );

    expect(report.verificationRate).toBeGreaterThan(0.9);
    expect(report.fallbackRate).toBeGreaterThan(0.6); // most of the unreachable-on-WhatsApp share fell back
  });

  it("verification rate equals delivery rate when every user is reachable, patient, and fast (the null model)", async () => {
    const report = await runScenario(
      scenario({
        seed: 7,
        verifications: 500,
        population: {
          whatsappReachableShare: 1,
          abandonRate: 0,
          // Effectively instant relative to the channel timeout — response delay
          // essentially never exceeds it.
          meanResponseDelayMs: { whatsapp: 1, sms: 1 },
        },
        providers: {
          whatsapp: { failureRate: 0, failureCode: "provider_error" },
          sms: { failureRate: 0, failureCode: "provider_error" },
        },
      }),
    );

    // The point of this test: the model is capable of collapsing verification rate
    // onto delivery rate given the right (unrealistic) population — proving the gap
    // seen above comes from the population parameters, not a bug that always
    // under-counts verifications.
    expect(report.verificationRate).toBeCloseTo(report.deliveryRate, 2);
    expect(report.verificationRate).toBeGreaterThan(0.95);
  });
});

describe("runScenario — cost per successful verification (R9.5/G8)", () => {
  it("charges rateMicros once per successful send, never for a hard failure", async () => {
    const report = await runScenario(
      scenario({
        seed: 7,
        verifications: 500,
        policy: { version: 1, rules: [], default: { channels: ["whatsapp"] } },
        population: {
          whatsappReachableShare: 1,
          abandonRate: 0,
          meanResponseDelayMs: { whatsapp: 1, sms: 1 },
        },
        providers: {
          whatsapp: { failureRate: 0, failureCode: "provider_error", rateMicros: 100_000 },
          sms: { failureRate: 0, failureCode: "provider_error", rateMicros: 200_000 },
        },
      }),
    );

    // Single-channel, always-succeeds, always-verifies: cost/success is exactly
    // WhatsApp's rate, not inflated by a channel that was never attempted.
    expect(report.costPerVerifiedMicros).toBeCloseTo(100_000, 0);
  });

  it("reports cost as unknown, not zero, when a corridor has no configured rate", async () => {
    const report = await runScenario(
      scenario({
        seed: 7,
        providers: {
          whatsapp: { failureRate: 0.02, failureCode: "provider_error" }, // no rateMicros
          sms: { failureRate: 0.01, failureCode: "provider_error", rateMicros: 150_000 },
        },
      }),
    );

    // An unpriced corridor makes the total unknowable, not smaller — this is the same
    // discipline Phase 7's daily-spend ceiling needs for a NULL cost_micros_at_send.
    expect(report.costPerVerifiedMicros).toBeNull();
  });
});
