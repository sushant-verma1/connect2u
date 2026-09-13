import { z } from "zod";
import { CHANNELS } from "../fallback/channel-chain.js";

// R3.1/R3.2: declarative, per-account, versioned, Zod-validated — this schema is the
// one place "declarative" is enforced. Both the API's PUT validation and matchPolicy's
// input type come from here, so there is exactly one definition of what a policy is.
const channelEnum = z.enum(CHANNELS);

const timeoutsMsSchema = z
  .object({
    whatsapp: z.number().int().positive().optional(),
    sms: z.number().int().positive().optional(),
  })
  .partial()
  .optional();

// R3.2: match on country, prefix, risk level, or metadata. Every key present must match
// the routing input for the rule to apply (matchPolicy.ts) — omitted keys are wildcards.
const ruleMatchSchema = z.object({
  country: z.string().optional(),
  prefix: z.string().optional(),
  risk: z.string().optional(),
  metadata: z.record(z.string()).optional(),
});

const ruleOutcomeSchema = z.object({
  channels: z.array(channelEnum).min(1),
  timeouts_ms: timeoutsMsSchema,
  max_cost_micros: z.number().int().positive().optional(),
  reason: z.string().optional(),
});

const ruleSchema = ruleOutcomeSchema.extend({ match: ruleMatchSchema });

export const routingPolicySchema = z.object({
  version: z.number().int().positive(),
  rules: z.array(ruleSchema).default([]),
  default: ruleOutcomeSchema,
});

export type RuleMatch = z.infer<typeof ruleMatchSchema>;
export type RuleOutcome = z.infer<typeof ruleOutcomeSchema>;
export type PolicyRule = z.infer<typeof ruleSchema>;
export type RoutingPolicy = z.infer<typeof routingPolicySchema>;

// R3.1: every new account gets this until it PUTs its own policy — matches the
// pre-Phase-5 hardcoded default (channel-chain.ts's DEFAULT_CHANNEL_CHAIN).
export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  version: 1,
  rules: [],
  default: { channels: ["whatsapp", "sms"] },
};
