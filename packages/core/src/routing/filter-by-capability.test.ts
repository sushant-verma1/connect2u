import { describe, expect, it } from "vitest";
import { filterByCapability } from "./filter-by-capability.js";
import type { CandidateChannel, CapabilityRecord } from "./types.js";

const NOW = new Date("2026-09-13T00:00:00Z");

const CANDIDATES: CandidateChannel[] = [
  { channel: "whatsapp", timeoutMs: 20_000 },
  { channel: "sms", timeoutMs: 30_000 },
];

function record(overrides: Partial<CapabilityRecord>): CapabilityRecord {
  return {
    channel: "whatsapp",
    capability: "unknown",
    confidence: 0.5,
    lastSuccessAt: null,
    consecutiveFailures: 0,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("filterByCapability", () => {
  it("drops a channel with two or more consecutive failures", () => {
    const result = filterByCapability(
      CANDIDATES,
      [record({ channel: "whatsapp", consecutiveFailures: 2 })],
      NOW,
    );
    expect(result.candidates.map((c) => c.channel)).toEqual(["sms"]);
    expect(result.decisionLog).toContainEqual(
      expect.objectContaining({ action: "skipped", channel: "whatsapp" }),
    );
  });

  it("keeps a channel with only one consecutive failure", () => {
    const result = filterByCapability(
      CANDIDATES,
      [record({ channel: "whatsapp", consecutiveFailures: 1 })],
      NOW,
    );
    expect(result.candidates.map((c) => c.channel)).toEqual(["whatsapp", "sms"]);
  });

  it("reorders a likely channel ahead of the policy's given order", () => {
    const result = filterByCapability(
      CANDIDATES,
      [record({ channel: "sms", capability: "likely", confidence: 0.9, updatedAt: NOW })],
      NOW,
    );
    expect(result.candidates.map((c) => c.channel)).toEqual(["sms", "whatsapp"]);
  });

  it("pushes an unlikely channel behind an unscored one", () => {
    const result = filterByCapability(
      CANDIDATES,
      [
        record({
          channel: "whatsapp",
          capability: "unlikely",
          confidence: 0.9,
          consecutiveFailures: 1,
        }),
      ],
      NOW,
    );
    expect(result.candidates.map((c) => c.channel)).toEqual(["sms", "whatsapp"]);
  });

  it("leaves order untouched — and logs nothing — when nothing is known yet", () => {
    const result = filterByCapability(CANDIDATES, [], NOW);
    expect(result.candidates.map((c) => c.channel)).toEqual(["whatsapp", "sms"]);
    expect(result.decisionLog).toEqual([]);
  });
});
