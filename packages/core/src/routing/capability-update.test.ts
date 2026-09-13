import { describe, expect, it } from "vitest";
import {
  applyDeliveryOutcome,
  decayConfidence,
  initialCapabilityRecord,
} from "./capability-update.js";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("decayConfidence", () => {
  it("is unchanged at age zero", () => {
    expect(decayConfidence(0.8, 0)).toBe(0.8);
  });

  it("halves after one half-life (30 days)", () => {
    expect(decayConfidence(0.8, 30 * DAY_MS)).toBeCloseTo(0.4, 5);
  });

  it("quarters after two half-lives", () => {
    expect(decayConfidence(0.8, 60 * DAY_MS)).toBeCloseTo(0.2, 5);
  });
});

describe("initialCapabilityRecord", () => {
  it("starts neutral — unknown, no failure streak, no success yet", () => {
    const now = new Date("2026-09-13T00:00:00Z");
    expect(initialCapabilityRecord("whatsapp", now)).toEqual({
      channel: "whatsapp",
      capability: "unknown",
      confidence: 0.5,
      lastSuccessAt: null,
      consecutiveFailures: 0,
      updatedAt: now,
    });
  });
});

describe("applyDeliveryOutcome", () => {
  const now = new Date("2026-09-13T00:00:00Z");
  const base = initialCapabilityRecord("whatsapp", now);

  it("raises confidence and flips to likely on success", () => {
    const updated = applyDeliveryOutcome(base, "success", now);
    expect(updated.confidence).toBeCloseTo(0.8, 5);
    expect(updated.capability).toBe("likely");
    expect(updated.consecutiveFailures).toBe(0);
    expect(updated.lastSuccessAt).toEqual(now);
  });

  it("lowers confidence and counts a failure", () => {
    const updated = applyDeliveryOutcome(base, "failure", now);
    expect(updated.confidence).toBeCloseTo(0.2, 5);
    expect(updated.consecutiveFailures).toBe(1);
    expect(updated.capability).toBe("unknown");
  });

  it("flips to unlikely on the second consecutive failure", () => {
    const onceFailed = applyDeliveryOutcome(base, "failure", now);
    const twiceFailed = applyDeliveryOutcome(onceFailed, "failure", now);
    expect(twiceFailed.consecutiveFailures).toBe(2);
    expect(twiceFailed.capability).toBe("unlikely");
  });

  it("a success after a failure streak resets it", () => {
    const failed = applyDeliveryOutcome(base, "failure", now);
    const recovered = applyDeliveryOutcome(failed, "success", now);
    expect(recovered.consecutiveFailures).toBe(0);
  });

  it("never pushes confidence outside [0, 1]", () => {
    let record = base;
    for (let i = 0; i < 10; i++) {
      record = applyDeliveryOutcome(record, "success", now);
    }
    expect(record.confidence).toBeLessThanOrEqual(1);

    record = base;
    for (let i = 0; i < 10; i++) {
      record = applyDeliveryOutcome(record, "failure", now);
    }
    expect(record.confidence).toBeGreaterThanOrEqual(0);
  });

  it("decays from the stored confidence at the outcome's own clock, not a stale value", () => {
    const monthLater = new Date(now.getTime() + 30 * DAY_MS);
    const likely = applyDeliveryOutcome(base, "success", now); // confidence 0.8
    const updated = applyDeliveryOutcome(likely, "failure", monthLater);
    // 0.8 decayed by one half-life = 0.4, then -0.3 = 0.1
    expect(updated.confidence).toBeCloseTo(0.1, 5);
  });
});
