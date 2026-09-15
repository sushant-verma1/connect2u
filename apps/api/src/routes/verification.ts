import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Redis } from "ioredis";
import { ulid } from "ulid";
import { z } from "zod";
import type { PgClient } from "@otp-router/db/client";
import {
  insertVerification,
  findVerificationScoped,
} from "@otp-router/db/repositories/verifications";
import {
  findDeliveryAttemptsByVerification,
  insertDeliveryAttempt,
} from "@otp-router/db/repositories/delivery-attempts";
import { findActiveRoutingPolicy } from "@otp-router/db/repositories/routing-policies";
import { findCapabilityByPhoneHash } from "@otp-router/db/repositories/channel-capability";
import { findLatestScoresByCountry } from "@otp-router/db/repositories/channel-scores";
import { findApplicableRate } from "@otp-router/db/repositories/provider-rates";
import { insertRoutingDecision } from "@otp-router/db/repositories/routing-decisions";
import { CHECK_OUTCOMES } from "@otp-router/core/state-machine/check-outcome";
import {
  CHANNEL_TIMEOUT_MS,
  CHANNELS,
  type Channel,
} from "@otp-router/core/fallback/channel-chain";
import { classifyCountry } from "@otp-router/core/pricing/country";
import { DEFAULT_ROUTING_POLICY, routingPolicySchema } from "@otp-router/core/routing/policy";
import { buildRoutingPlan } from "@otp-router/core/routing/build-plan";
import type { ProviderRateRecord, RoutingInput } from "@otp-router/core/routing/types";
import { fallbackTimerJobId } from "@otp-router/core/queue/fallback-job";
import type { ApiKeyAuth } from "../auth/api-key-auth.js";
import type { SessionAuth } from "../auth/session.js";
import { encryptCode } from "../crypto/code-encryption.js";
import { generateCode } from "../crypto/code.js";
import { hmacHex } from "../crypto/hmac.js";
import { hashPhone, normalizePhoneNumber } from "../crypto/phone.js";
import { encryptPhone } from "../crypto/phone-encryption.js";
import { checkVerification } from "../services/check-verification.js";
import { checkStartRateLimits } from "../services/rate-limit.js";
import { checkPrefixVelocity, recordAndCheckCountryMix } from "../services/fraud-signals.js";
import { findReplayedStart } from "../services/idempotency.js";
import { buildTrace } from "../services/trace.js";
import type { Config } from "../config.js";
import type { Queues } from "../queue/queues.js";

const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

const MAX_METADATA_BYTES = 4096;

const startBodySchema = z.object({
  phone_number: z.string().min(1),
  channels: z.array(z.enum(["whatsapp", "sms"])).optional(),
  locale: z.string().optional(),
  code_length: z.number().int().min(4).max(8).default(6),
  ttl_seconds: z.number().int().min(60).max(900).default(300),
  metadata: z.record(z.unknown()).optional(),
});

const startResponseSchema = z.object({
  verification_id: z.string(),
  status: z.literal("pending"),
  channel_attempted: z.enum(["whatsapp", "sms"]),
  expires_at: z.string(),
});

const checkBodySchema = z.object({
  verification_id: z.string().min(1),
  code: z.string().min(1),
});

const checkResponseSchema = z.object({
  verification_id: z.string(),
  status: z.enum(CHECK_OUTCOMES),
  // Nullable, not merely optional: a verified verification whose attribution resolved
  // to nothing reports null rather than a channel name (check-verification.ts).
  channel_verified: z.string().nullable().optional(),
  attempts_used: z.number().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const errorResponseSchema = z.object({
  error: z.string(),
});

const getParamsSchema = z.object({
  id: z.string().min(1),
});

const getResponseSchema = z.object({
  verification_id: z.string(),
  status: z.enum(["pending", "verified", "expired", "burned", "failed"]),
  expires_at: z.string(),
  attempts_used: z.number(),
  max_attempts: z.number(),
  channel_verified: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const traceParamsSchema = z.object({ id: z.string().min(1) });

// R10.6: the trace view's whole payload — mirrors packages/core/src/routing/types.ts's
// DecisionLogEntry shape exactly, since decisionLogJson is written straight from a
// RoutingPlan and this is that same log read back.
const decisionLogEntrySchema = z.object({
  stage: z.enum(["match_policy", "capability_filter", "score_rank", "cost_ceiling"]),
  action: z.enum(["considered", "skipped", "reordered", "chosen"]),
  channel: z.string().optional(),
  reason: z.string(),
});

const traceWebhookEventSchema = z.object({
  provider: z.string(),
  event_type: z.string(),
  signature_valid: z.boolean().nullable(),
  created_at: z.string(),
});

const traceAttemptSchema = z.object({
  id: z.string(),
  channel: z.string(),
  provider: z.string(),
  status: z.enum(["queued", "sent", "delivered", "failed", "timed_out"]),
  error_code: z.string().nullable(),
  cost_micros_at_send: z.number().nullable(),
  sent_at: z.string().nullable(),
  delivered_at: z.string().nullable(),
  failed_at: z.string().nullable(),
  timeout_at: z.string().nullable(),
  webhook_events: z.array(traceWebhookEventSchema),
});

const traceResponseSchema = z.object({
  verification_id: z.string(),
  status: z.enum(["pending", "verified", "expired", "burned", "failed"]),
  channel_chain: z.array(z.string()),
  channel_timeouts_ms: z.record(z.number()),
  attempts_used: z.number(),
  max_attempts: z.number(),
  created_at: z.string(),
  expires_at: z.string(),
  verified_at: z.string().nullable(),
  verified_channel: z.string().nullable(),
  time_to_verify_ms: z.number().nullable(),
  routing_decision: z
    .object({
      considered: z.array(z.string()),
      chosen_channel: z.string().nullable(),
      decision_log: z.array(decisionLogEntrySchema),
    })
    .nullable(),
  attempts: z.array(traceAttemptSchema),
});

type DecisionStage = "match_policy" | "capability_filter" | "score_rank" | "cost_ceiling";
type DecisionAction = "considered" | "skipped" | "reordered" | "chosen";

function isDecisionStage(value: string): value is DecisionStage {
  return (
    value === "match_policy" ||
    value === "capability_filter" ||
    value === "score_rank" ||
    value === "cost_ceiling"
  );
}

function isDecisionAction(value: string): value is DecisionAction {
  return (
    value === "considered" || value === "skipped" || value === "reordered" || value === "chosen"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export type ParsedDecisionLogEntry = Readonly<{
  stage: DecisionStage;
  action: DecisionAction;
  channel?: string;
  reason: string;
}>;

/**
 * R10.6: `routing_decisions.decision_log_json` is typed `unknown` at the schema level
 * (packages/db/src/schema.ts) — it's written straight from `RoutingPlan.decisionLog`
 * (packages/core/src/routing/types.ts's `DecisionLogEntry[]`), but the trace endpoint
 * narrows it field by field rather than asserting the type, the same way every other
 * `unknown` webhook/JSON payload in this codebase gets narrowed (see
 * `packages/providers/src/provider.ts`'s `isRecord`). A malformed entry is dropped, not
 * thrown — a trace with one bad entry missing is more useful than a trace that 500s.
 */
function parseDecisionLog(raw: unknown): ParsedDecisionLogEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: ParsedDecisionLogEntry[] = [];
  for (const entry of raw) {
    if (
      isRecord(entry) &&
      typeof entry.stage === "string" &&
      isDecisionStage(entry.stage) &&
      typeof entry.action === "string" &&
      isDecisionAction(entry.action) &&
      typeof entry.reason === "string"
    ) {
      entries.push({
        stage: entry.stage,
        action: entry.action,
        channel: typeof entry.channel === "string" ? entry.channel : undefined,
        reason: entry.reason,
      });
    }
  }
  return entries;
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

export function registerVerificationRoutes(
  app: FastifyInstance,
  pg: PgClient,
  redis: Redis,
  queues: Queues,
  apiKeyAuth: ApiKeyAuth,
  config: Config,
): void {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.post(
    "/v1/verification/start",
    {
      preHandler: apiKeyAuth,
      schema: {
        body: startBodySchema,
        response: {
          202: startResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          422: errorResponseSchema,
          429: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const body = request.body;

      if (body.metadata && Buffer.byteLength(JSON.stringify(body.metadata)) > MAX_METADATA_BYTES) {
        return reply.code(422).send({ error: "metadata_too_large" });
      }

      const normalizedPhone = normalizePhoneNumber(body.phone_number);
      if (!normalizedPhone) {
        return reply.code(422).send({ error: "invalid_phone_number" });
      }

      const phoneHash = hashPhone(normalizedPhone, config.phoneHashPepper);

      // R1.1.6/T4: checked before any rate limiting or fraud signal — a replay is not
      // a new request in any sense those exist to police, and re-running them against
      // an already-completed call would double-count against the caller's own limits.
      const idempotencyKey = request.headers[IDEMPOTENCY_KEY_HEADER];
      if (typeof idempotencyKey === "string" && idempotencyKey.length > 0) {
        const replayed = await findReplayedStart(pg, request.account.id, idempotencyKey);
        if (replayed) {
          return reply.code(202).send(replayed);
        }
      }

      // R1.1.5/R1.1.7/R7.6/R7.7: independent Redis checks, run concurrently — three
      // sequential round trips alone measured enough latency to blow /start's 100ms
      // budget (R1.1.5), for no correctness benefit over running them together.
      // Country-mix (R7.7) never rejects, so it just needs its own errors not to crash
      // the request — it's genuinely fire-and-forget, unlike the other two.
      const country = classifyCountry(normalizedPhone);
      const metadata = stringMetadata(body.metadata);

      const [breach, escalated] = await Promise.all([
        checkStartRateLimits(redis, {
          phoneHash,
          accountId: request.account.id,
          ip: request.ip,
        }),
        checkPrefixVelocity(
          redis,
          pg,
          { accountId: request.account.id, phoneNumber: normalizedPhone },
          request.log,
        ),
        recordAndCheckCountryMix(redis, request.account.id, country, request.log),
      ]);

      // R1.1.7/R7.1: number, account, and IP — three independent ceilings, checked
      // before any further work so a request that's going to be rejected doesn't pay
      // for routing lookups or a Postgres write first.
      if (breach) {
        const retryAfterSec = Math.max(1, Math.ceil(breach.retryAfterMs / 1000));
        reply.header("Retry-After", String(retryAfterSec));
        return reply.code(429).send({ error: `rate_limited_${breach.scope}` });
      }

      // R7.6: an account-level fraud signal — a breach both trips the account to
      // manual_review (halting every later request too, once auth's cache sees it)
      // and rejects this one outright.
      if (escalated) {
        return reply.code(403).send({ error: "account_under_review" });
      }

      const routingInput: RoutingInput = {
        accountId: request.account.id,
        phoneHash,
        country,
        prefix: normalizedPhone,
        risk: metadata.risk,
        metadata,
        requestedChannels: body.channels,
        now: new Date(),
      };

      // R3.1/R3.3: whichever policy is active right now — a PUT to
      // /v1/accounts/me/routing-policy changes this on the very next /start, no deploy.
      // None of these four reads depend on each other — run them concurrently rather
      // than serially, since R1.1.5 holds /start to under 100ms regardless.
      const [policyRow, capability, scores, rates] = await Promise.all([
        findActiveRoutingPolicy(pg, request.account.id),
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
        return reply.code(422).send({ error: "no_channel_available" });
      }

      const code = generateCode(body.code_length);
      const expiresAt = new Date(Date.now() + body.ttl_seconds * 1000);
      const verificationId = `ver_${ulid()}`;

      try {
        await insertVerification(pg, {
          id: verificationId,
          accountId: request.account.id,
          phoneHash,
          phoneEncrypted: encryptPhone(normalizedPhone, config.phoneEncryptionKey),
          codeHmac: hmacHex(code, config.otpPepper),
          // R2.3: encrypted, not hashed — this is what lets a later channel in the chain
          // resend the exact same code (a fallback must never regenerate it).
          codeEncrypted: encryptCode(code, config.codeEncryptionKey),
          channelChain: [...plan.orderedChannels],
          channelTimeoutsMs: { ...plan.timeouts },
          expiresAt,
          metadataJson: body.metadata ?? {},
          idempotencyKey: typeof idempotencyKey === "string" ? idempotencyKey : null,
        });
      } catch (err) {
        // R1.1.6/T4: two genuinely concurrent requests carrying the same Idempotency-Key
        // both passed the lookup above before either had inserted — `postgres`
        // surfaces Postgres's unique_violation as `code: "23505"` on the
        // `verifications_account_idempotency_key_idx` constraint. The loser here isn't
        // an error: it re-reads whichever row the winner just inserted and returns
        // that exact response instead, so this request still sends nothing new.
        const isUniqueViolation =
          typeof idempotencyKey === "string" &&
          err !== null &&
          typeof err === "object" &&
          "code" in err &&
          err.code === "23505";
        if (!isUniqueViolation) throw err;

        const replayed = await findReplayedStart(pg, request.account.id, idempotencyKey);
        if (!replayed) throw err;
        return reply.code(202).send(replayed);
      }

      // R3.9: persisted whole — every channel the policy proposed, the one chosen, and
      // the reason for every skip along the way.
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
        accountId: request.account.id,
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
          accountId: request.account.id,
          phoneNumber: normalizedPhone,
          code,
          channel: firstChannel,
          correlationId: request.correlationId,
          timeoutMs: plan.timeouts[firstChannel] ?? CHANNEL_TIMEOUT_MS[firstChannel],
        },
        { jobId: attemptId },
      );

      return reply.code(202).send({
        verification_id: verificationId,
        status: "pending",
        channel_attempted: firstChannel,
        expires_at: expiresAt.toISOString(),
      });
    },
  );

  server.post(
    "/v1/verification/check",
    {
      preHandler: apiKeyAuth,
      schema: {
        body: checkBodySchema,
        response: { 200: checkResponseSchema, 401: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const body = request.body;

      const result = await checkVerification(pg, {
        verificationId: body.verification_id,
        accountId: request.account.id,
        code: body.code,
        otpPepper: config.otpPepper,
      });

      // R1.2.4: on success, cancel every pending fallback timer for this verification.
      // Best-effort (ARCHITECTURE.md §6) — the timer processor's own conditional
      // UPDATE (R4.3/I9) is what actually guarantees correctness if this misses or a
      // timer already fired.
      if (result.outcome === "verified") {
        const attempts = await findDeliveryAttemptsByVerification(pg, body.verification_id);
        await Promise.all(
          attempts.map((attempt) => queues.fallbackQueue.remove(fallbackTimerJobId(attempt.id))),
        );
      }

      return reply.code(200).send({
        verification_id: body.verification_id,
        status: result.outcome,
        channel_verified:
          result.outcome === "verified"
            ? (result.verification?.verifiedChannel ?? null)
            : undefined,
        attempts_used: result.verification?.attemptsUsed,
        metadata: result.verification?.metadataJson,
      });
    },
  );

  server.get(
    "/v1/verification/:id",
    {
      preHandler: apiKeyAuth,
      schema: {
        params: getParamsSchema,
        response: { 200: getResponseSchema, 401: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const verification = await findVerificationScoped(pg, id, request.account.id);
      if (!verification) {
        return reply.code(404).send({ error: "not_found" });
      }

      return reply.code(200).send({
        verification_id: verification.id,
        status: verification.status,
        expires_at: verification.expiresAt.toISOString(),
        attempts_used: verification.attemptsUsed,
        max_attempts: verification.maxAttempts,
        channel_verified:
          verification.status === "verified" ? verification.verifiedChannel : undefined,
        metadata: verification.metadataJson,
      });
    },
  );

  // R10.6: the dashboard's trace screen — every attempt, every webhook, the routing
  // decision, and the reason each channel was skipped, in one response. No live
  // aggregation (that's R10.1's materialised-view screens); this is a targeted lookup
  // by one verification_id, which stays cheap without one.
  server.get(
    "/v1/verification/:id/trace",
    {
      preHandler: apiKeyAuth,
      schema: {
        params: traceParamsSchema,
        response: { 200: traceResponseSchema, 401: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const body = await buildTraceResponseBody(pg, id, request.account.id);
      if (!body) {
        return reply.code(404).send({ error: "not_found" });
      }
      return reply.code(200).send(body);
    },
  );
}

/**
 * R13.2/D2: the dashboard's trace screen needs a session-authenticated route, but
 * `/v1/verification/*` must stay API-key-only (the spec's own rule: a session never
 * authenticates a verification endpoint). Same response body, built by the same
 * function below, a different path and preHandler — the two inline handlers stay
 * separate only because each needs Fastify's own per-route Zod inference; the actual
 * query-and-shape logic lives in exactly one place, not two copies that can drift.
 */
export function registerDashboardTraceRoute(
  app: FastifyInstance,
  pg: PgClient,
  sessionAuth: SessionAuth,
): void {
  const server = app.withTypeProvider<ZodTypeProvider>();
  server.get(
    "/v1/dashboard/verifications/:id/trace",
    {
      preHandler: sessionAuth,
      schema: {
        params: traceParamsSchema,
        response: { 200: traceResponseSchema, 401: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const body = await buildTraceResponseBody(pg, id, request.account.id);
      if (!body) {
        return reply.code(404).send({ error: "not_found" });
      }
      return reply.code(200).send(body);
    },
  );
}

async function buildTraceResponseBody(
  pg: PgClient,
  verificationId: string,
  accountId: string,
): Promise<z.infer<typeof traceResponseSchema> | null> {
  const trace = await buildTrace(pg, { verificationId, accountId });
  if (!trace) {
    return null;
  }

  const { verification, routingDecision, attempts } = trace;

  return {
    verification_id: verification.id,
    status: verification.status,
    channel_chain: verification.channelChain,
    channel_timeouts_ms: verification.channelTimeoutsMs,
    attempts_used: verification.attemptsUsed,
    max_attempts: verification.maxAttempts,
    created_at: verification.createdAt.toISOString(),
    expires_at: verification.expiresAt.toISOString(),
    verified_at: verification.verifiedAt?.toISOString() ?? null,
    verified_channel: verification.verifiedChannel,
    time_to_verify_ms: verification.timeToVerifyMs,
    routing_decision: routingDecision
      ? {
          considered: [...routingDecision.consideredJson],
          chosen_channel: routingDecision.chosenChannel,
          decision_log: parseDecisionLog(routingDecision.decisionLogJson),
        }
      : null,
    attempts: attempts.map((attempt) => ({
      id: attempt.id,
      channel: attempt.channel,
      provider: attempt.provider,
      status: attempt.status,
      error_code: attempt.errorCode,
      cost_micros_at_send: attempt.costMicrosAtSend,
      sent_at: attempt.sentAt?.toISOString() ?? null,
      delivered_at: attempt.deliveredAt?.toISOString() ?? null,
      failed_at: attempt.failedAt?.toISOString() ?? null,
      timeout_at: attempt.timeoutAt?.toISOString() ?? null,
      webhook_events: attempt.webhookEvents.map((event) => ({
        provider: event.provider,
        event_type: event.eventType,
        signature_valid: event.signatureValid,
        created_at: event.createdAt.toISOString(),
      })),
    })),
  };
}
