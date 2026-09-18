import { ulid } from "ulid";
import type { PgClient } from "@otp-router/db/client";
import { insertVerification } from "@otp-router/db/repositories/verifications";
import { insertDeliveryAttempt } from "@otp-router/db/repositories/delivery-attempts";
import { findActiveRoutingPolicy } from "@otp-router/db/repositories/routing-policies";
import { findCapabilityByPhoneHash } from "@otp-router/db/repositories/channel-capability";
import { findLatestScoresByCountry } from "@otp-router/db/repositories/channel-scores";
import { findApplicableRate } from "@otp-router/db/repositories/provider-rates";
import { insertRoutingDecision } from "@otp-router/db/repositories/routing-decisions";
import {
  CHANNEL_TIMEOUT_MS,
  CHANNELS,
  type Channel,
} from "@otp-router/core/fallback/channel-chain";
import { classifyCountry } from "@otp-router/core/pricing/country";
import { DEFAULT_ROUTING_POLICY, routingPolicySchema } from "@otp-router/core/routing/policy";
import { buildRoutingPlan } from "@otp-router/core/routing/build-plan";
import type { ProviderRateRecord, RoutingInput } from "@otp-router/core/routing/types";
import { encryptCode } from "../crypto/code-encryption.js";
import { generateCode } from "../crypto/code.js";
import { hmacHex } from "../crypto/hmac.js";
import { hashPhone } from "../crypto/phone.js";
import { encryptPhone } from "../crypto/phone-encryption.js";
import type { Config } from "../config.js";
import type { Queues } from "../queue/queues.js";

/** G8/R3.7's provider-attribution convention: whatsapp is priced/scored as if sent via
 * Meta, sms via a generic SMS provider — the literal `delivery_attempts.provider` stays
 * "simulated" today (PROJECT.md's WABA constraint), but cost and country classification
 * reflect what the channel actually costs. */
function rateProviderFor(channel: Channel): string {
  return channel === "whatsapp" ? "meta" : "generic_sms";
}

async function loadProviderRates(
  pg: PgClient,
  country: string,
): Promise<readonly ProviderRateRecord[]> {
  const lookups = await Promise.all(
    CHANNELS.map(async (channel) => {
      const rate = await findApplicableRate(pg, {
        provider: rateProviderFor(channel),
        channel,
        country,
        messageType: "authentication",
      });
      return rate ? { channel, rateMicros: rate.rateMicros } : null;
    }),
  );
  return lookups.filter((rate): rate is ProviderRateRecord => rate !== null);
}

/** R3.2: RoutingInput.metadata is a flat string map — only the customer's string-valued
 * metadata fields are usable as match keys; a nested object or number can't be. */
function stringMetadata(metadata: Record<string, unknown> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (typeof value === "string") {
      result[key] = value;
    }
  }
  return result;
}

export type StartVerificationParams = Readonly<{
  accountId: string;
  normalizedPhone: string;
  codeLength: number;
  ttlSeconds: number;
  metadata?: Record<string, unknown>;
  requestedChannels?: readonly ("whatsapp" | "sms")[];
  idempotencyKey: string | null;
  correlationId: string;
}>;

export type StartVerificationOutcome =
  | Readonly<{ ok: true; verificationId: string; firstChannel: Channel; expiresAt: Date }>
  | Readonly<{ ok: false; error: "no_channel_available" }>;

/**
 * R3.4/R1.1.5's `/start` pipeline. Rate limiting, fraud signals, and the
 * Idempotency-Key replay/unique-violation dance stay in the calling route
 * (`apps/api/src/routes/verification.ts`) rather than here, since they're concerns of
 * an authenticated HTTP request, not of building a routing plan and enqueueing a send.
 *
 * The public demo (`apps/api/src/routes/demo.ts`) does not call this function — it is
 * a pure simulation over a Redis session and never creates a real verification — so
 * this has exactly one caller today. It stays a separate function regardless: the
 * pipeline (hash, classify, load policy/capability/scores/rates, build the plan,
 * persist, enqueue) is a distinct unit from HTTP concerns like rate limiting, and
 * splitting it here is what let packages/simulator's demo-session.ts reuse
 * `buildRoutingPlan` directly without reaching through an HTTP route to get to it.
 */
export async function startVerification(
  pg: PgClient,
  queues: Queues,
  config: Config,
  params: StartVerificationParams,
): Promise<StartVerificationOutcome> {
  const phoneHash = hashPhone(params.normalizedPhone, config.phoneHashPepper);
  const country = classifyCountry(params.normalizedPhone);
  const metadata = stringMetadata(params.metadata);

  const routingInput: RoutingInput = {
    accountId: params.accountId,
    phoneHash,
    country,
    prefix: params.normalizedPhone,
    risk: metadata.risk,
    metadata,
    requestedChannels: params.requestedChannels,
    now: new Date(),
  };

  // R3.1/R3.3: whichever policy is active right now — a PUT to
  // /v1/accounts/me/routing-policy changes this on the very next /start, no deploy.
  // None of these four reads depend on each other — run them concurrently rather than
  // serially, since R1.1.5 holds /start to under 100ms regardless.
  const [policyRow, capability, scores, rates] = await Promise.all([
    findActiveRoutingPolicy(pg, params.accountId),
    findCapabilityByPhoneHash(pg, phoneHash),
    findLatestScoresByCountry(pg, country),
    loadProviderRates(pg, country),
  ]);
  const policy = policyRow
    ? routingPolicySchema.parse(policyRow.policyJson)
    : DEFAULT_ROUTING_POLICY;

  const plan = buildRoutingPlan(policy, routingInput, capability, scores, rates);
  const firstChannel = plan.orderedChannels[0];
  if (!firstChannel) {
    return { ok: false, error: "no_channel_available" };
  }

  const code = generateCode(params.codeLength);
  const expiresAt = new Date(Date.now() + params.ttlSeconds * 1000);
  const verificationId = `ver_${ulid()}`;

  await insertVerification(pg, {
    id: verificationId,
    accountId: params.accountId,
    phoneHash,
    phoneEncrypted: encryptPhone(params.normalizedPhone, config.phoneEncryptionKey),
    codeHmac: hmacHex(code, config.otpPepper),
    // R2.3: encrypted, not hashed — this is what lets a later channel in the chain
    // resend the exact same code (a fallback must never regenerate it).
    codeEncrypted: encryptCode(code, config.codeEncryptionKey),
    channelChain: [...plan.orderedChannels],
    channelTimeoutsMs: { ...plan.timeouts },
    expiresAt,
    metadataJson: params.metadata ?? {},
    idempotencyKey: params.idempotencyKey,
  });

  // R3.9: persisted whole — every channel the policy proposed, the one chosen, and the
  // reason for every skip along the way.
  const considered = plan.decisionLog
    .filter((entry) => entry.stage === "match_policy" && entry.action === "considered")
    .map((entry) => entry.channel)
    .filter((channel): channel is Channel => channel !== undefined);
  await insertRoutingDecision(pg, {
    id: `rtd_${ulid()}`,
    verificationId,
    consideredJson: considered,
    chosenChannel: firstChannel,
    decisionLogJson: plan.decisionLog,
  });

  const attemptId = `att_${ulid()}`;
  await insertDeliveryAttempt(pg, {
    id: attemptId,
    verificationId,
    accountId: params.accountId,
    channel: firstChannel,
    provider: "simulated",
    status: "queued",
  });

  // R1.1.5: the API never calls a provider — it only enqueues. `jobId: attemptId`
  // makes re-enqueueing the same attempt a no-op instead of a duplicate job.
  await queues.deliveryQueue.add(
    "send",
    {
      attemptId,
      verificationId,
      accountId: params.accountId,
      phoneNumber: params.normalizedPhone,
      code,
      channel: firstChannel,
      correlationId: params.correlationId,
      timeoutMs: plan.timeouts[firstChannel] ?? CHANNEL_TIMEOUT_MS[firstChannel],
    },
    { jobId: attemptId },
  );

  return { ok: true, verificationId, firstChannel, expiresAt };
}
