import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { CHANNELS } from "@otp-router/core/fallback/channel-chain";
import { routingPolicySchema } from "@otp-router/core/routing/policy";
import { PROVIDER_ERROR_CODES } from "@otp-router/providers/provider";
import type { ScenarioConfig } from "./scenario.js";

// R9.1: the on-disk YAML shape — per-channel latency distributions, failure rates,
// webhook chaos rates, late-delivery probability, and the share of the population
// reachable on WhatsApp. Validated with Zod so a malformed scenario file fails loudly
// at load time rather than producing a silently-wrong report.
const channelEnum = z.enum(CHANNELS);

const channelProviderConfigSchema = z.object({
  failureRate: z.number().min(0).max(1).default(0),
  failureCode: z.enum(PROVIDER_ERROR_CODES).default("provider_error"),
  meanLatencyMs: z.number().min(0).default(0),
  webhookChaosRate: z.number().min(0).max(1).default(0),
  lateDeliveryRate: z.number().min(0).max(1).default(0),
  lateDeliveryExtraMs: z.number().min(0).default(0),
  // R9.5/G8: no default — omitted means unpriced, not free (see scenario.ts).
  rateMicros: z.number().int().nonnegative().optional(),
});

const populationConfigSchema = z.object({
  whatsappReachableShare: z.number().min(0).max(1),
  abandonRate: z.number().min(0).max(1),
  whatsappBrokenShare: z.number().min(0).max(1).default(0),
  meanResponseDelayMs: z.object({
    whatsapp: z.number().positive(),
    sms: z.number().positive(),
  }),
});

export const scenarioFileSchema = z.object({
  seed: z.number().int(),
  verifications: z.number().int().positive(),
  arrivalIntervalMs: z.number().int().positive(),
  uniquePhoneNumbers: z.number().int().positive().optional(),
  fixedChain: z.array(channelEnum).min(1).optional(),
  disableScoreRanking: z.boolean().optional(),
  policy: routingPolicySchema.optional(),
  population: populationConfigSchema,
  providers: z.object({
    whatsapp: channelProviderConfigSchema,
    sms: channelProviderConfigSchema,
  }),
});

export function parseScenario(raw: unknown): ScenarioConfig {
  return scenarioFileSchema.parse(raw);
}

export function loadScenarioFile(path: string): ScenarioConfig {
  return parseScenario(parseYaml(readFileSync(path, "utf8")));
}

// R9.8: the three presets PLAN.md's Phase 6 names, shipped as YAML alongside the
// loader so `pnpm simulate --scenario=india-mixed` and reading the scenario as a
// hand-editable file are the same code path.
export const PRESET_NAMES = ["india-mixed", "whatsapp-degraded", "cold-start"] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

export function isPresetName(value: string): value is PresetName {
  return PRESET_NAMES.some((preset) => preset === value);
}

export function loadPreset(name: string): ScenarioConfig {
  if (!isPresetName(name)) {
    throw new Error(
      `Unknown scenario preset "${name}" — expected one of: ${PRESET_NAMES.join(", ")}`,
    );
  }
  const presetPath = fileURLToPath(new URL(`../scenarios/${name}.yaml`, import.meta.url));
  return loadScenarioFile(presetPath);
}
