import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PRESET_NAMES, loadPreset, loadScenarioFile, parseScenario } from "./scenario-loader.js";

describe("scenario-loader — R9.1 YAML scenario format", () => {
  it.each(PRESET_NAMES)("loads the %s preset without throwing", (name) => {
    const scenario = loadPreset(name);
    expect(scenario.verifications).toBeGreaterThan(0);
  });

  it("rejects an unknown preset name", () => {
    expect(() => loadPreset("not-a-real-preset")).toThrow(/Unknown scenario preset/);
  });

  it("fills per-channel defaults (latency, webhook chaos, late delivery) when a YAML file omits them", () => {
    const scenario = parseScenario({
      seed: 1,
      verifications: 10,
      arrivalIntervalMs: 100,
      population: {
        whatsappReachableShare: 0.5,
        abandonRate: 0.1,
        meanResponseDelayMs: { whatsapp: 1000, sms: 1000 },
      },
      providers: {
        whatsapp: { failureRate: 0.1 },
        sms: { failureRate: 0.1 },
      },
    });

    expect(scenario.providers.whatsapp.meanLatencyMs).toBe(0);
    expect(scenario.providers.whatsapp.webhookChaosRate).toBe(0);
    expect(scenario.providers.whatsapp.lateDeliveryRate).toBe(0);
  });

  it("rejects a malformed scenario file instead of producing a silently-wrong report", () => {
    expect(() => parseScenario({ seed: "not-a-number", verifications: 10 })).toThrow();
  });

  it("loads a real YAML file from disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "scenario-test-"));
    const path = join(dir, "scenario.yaml");
    writeFileSync(
      path,
      [
        "seed: 5",
        "verifications: 10",
        "arrivalIntervalMs: 100",
        "population:",
        "  whatsappReachableShare: 0.5",
        "  abandonRate: 0.1",
        "  meanResponseDelayMs:",
        "    whatsapp: 1000",
        "    sms: 1000",
        "providers:",
        "  whatsapp:",
        "    failureRate: 0.1",
        "  sms:",
        "    failureRate: 0.1",
        "",
      ].join("\n"),
    );

    const scenario = loadScenarioFile(path);
    expect(scenario.seed).toBe(5);
    expect(scenario.verifications).toBe(10);
  });
});
