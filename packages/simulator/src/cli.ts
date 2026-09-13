import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { CHANNELS, type Channel } from "@otp-router/core/fallback/channel-chain";
import { compareScenarios } from "./ab.js";
import { PRESET_NAMES, isPresetName, loadPreset, loadScenarioFile } from "./scenario-loader.js";
import { runScenario } from "./runner.js";
import type { Report } from "./report.js";
import type { ScenarioConfig } from "./scenario.js";

function parseChannel(value: string): Channel {
  const channel = CHANNELS.find((c) => c === value);
  if (!channel) throw new Error(`"${value}" is not a known channel (${CHANNELS.join(", ")})`);
  return channel;
}

/**
 * `pnpm simulate --scenario=india-mixed --seed=42` (PROJECT.md's Definition of Done
 * #1) and `pnpm simulate --scenario=india-mixed --ab` (R9.7) both go through here.
 * `--scenario` accepts either an `R9.8` preset name or a path to a scenario YAML file.
 */
const { values } = parseArgs({
  options: {
    scenario: { type: "string" },
    seed: { type: "string" },
    ab: { type: "boolean", default: false },
    "fixed-chain": { type: "string", default: "whatsapp,sms" },
  },
});

function loadNamedScenario(name: string): ScenarioConfig {
  if (isPresetName(name)) return loadPreset(name);
  if (existsSync(name)) return loadScenarioFile(name);
  throw new Error(
    `"${name}" is neither a known preset (${PRESET_NAMES.join(", ")}) nor an existing file path`,
  );
}

function formatMicros(micros: number | null): string {
  // Micros are the same unit as provider_rates.rate_micros — divide by 1e6 for the
  // currency unit that rate card is denominated in (INR here).
  return micros === null ? "unknown" : (micros / 1_000_000).toFixed(4);
}

function printReport(label: string, report: Report): void {
  console.log(`\n${label}`);
  console.table({
    verifications: report.verifications,
    verificationRate: report.verificationRate.toFixed(4),
    deliveryRate: report.deliveryRate.toFixed(4),
    fallbackRate: report.fallbackRate.toFixed(4),
    "p50 (ms)": report.timeToVerifyMsP50 ?? "n/a",
    "p95 (ms)": report.timeToVerifyMsP95 ?? "n/a",
    "cost/verified": formatMicros(report.costPerVerifiedMicros),
  });
  console.log(JSON.stringify(report));
}

async function main(): Promise<void> {
  if (!values.scenario) {
    console.error(
      `Usage: pnpm simulate --scenario=<${PRESET_NAMES.join("|")}|path.yaml> [--seed=N] [--ab]`,
    );
    process.exitCode = 1;
    return;
  }

  const loaded = loadNamedScenario(values.scenario);
  const scenario: ScenarioConfig = values.seed ? { ...loaded, seed: Number(values.seed) } : loaded;

  if (!values.ab) {
    printReport(values.scenario, await runScenario(scenario));
    return;
  }

  // R9.7: outcome-scored routing (the engine, scenario.policy as-is) vs a fixed
  // channel-order baseline that never adapts — same population, providers, seed, and
  // arrival pattern on both arms (ab.ts enforces that by construction).
  const fixedChain = values["fixed-chain"].split(",").map((c) => parseChannel(c.trim()));
  const comparison = await compareScenarios(scenario, { fixedChain });
  printReport(`${values.scenario} — A: outcome-scored routing`, comparison.a);
  printReport(`${values.scenario} — B: fixed chain [${fixedChain.join(", ")}]`, comparison.b);
  console.log("\ndelta (B - A):");
  console.log({
    ...comparison.delta,
    costPerVerifiedMicros: formatMicros(comparison.delta.costPerVerifiedMicros),
  });
}

await main();
