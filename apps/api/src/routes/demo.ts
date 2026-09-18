import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Redis } from "ioredis";
import { z } from "zod";
import type { PgClient } from "@otp-router/db/client";
import { findActiveRoutingPolicy } from "@otp-router/db/repositories/routing-policies";
import { CHANNELS } from "@otp-router/core/fallback/channel-chain";
import { DEMO_ACCOUNT_ID } from "@otp-router/core/demo";
import {
  DEFAULT_ROUTING_POLICY,
  routingPolicySchema,
  type RoutingPolicy,
} from "@otp-router/core/routing/policy";
import {
  DEMO_ADAPTIVE_ATTEMPTS,
  DEMO_CALIBRATION_ATTEMPTS,
  beginAdaptiveAttempt,
  buildDemoReport,
  replaySession,
  sessionPhase,
  startSession,
  stepCalibration,
  verifyAdaptiveChannel,
  type DemoAttempt,
  type DemoReport,
  type DemoSessionState,
  type PendingAdaptiveAttempt,
} from "@otp-router/simulator/demo-session";
import {
  checkDemoActRateLimit,
  checkDemoReadRateLimit,
  checkDemoStartRateLimits,
} from "../services/rate-limit.js";

const errorResponseSchema = z.object({ error: z.string() });
const paramsSchema = z.object({ sessionId: z.string().min(1) });
const channelEnum = z.enum(CHANNELS);

// What's actually stored in Redis for a session — validated on read, not cast, even
// though this module is the only writer: a Zod parse here is what lets the type stay
// exactly DemoSessionState without an `as` to force it (AGENTS.md §6 bans that outright).
const decisionLogEntrySchema = z.object({
  stage: z.enum(["match_policy", "capability_filter", "score_rank", "cost_ceiling"]),
  action: z.enum(["considered", "skipped", "reordered", "chosen"]),
  channel: channelEnum.optional(),
  reason: z.string(),
});

// Internal (camelCase) shape -- exactly `DemoAttempt`/`PendingAdaptiveAttempt` from
// packages/simulator/src/demo-session.ts, as persisted verbatim to Redis by
// `saveSession`. The snake_case `attemptResponseSchema`/`pendingResponseSchema` below
// are the outward-facing reshape (`toAttemptResponse`/`toPendingResponse`), not this.
const demoChannelOutcomeInternalSchema = z.object({
  channel: channelEnum,
  outcome: z.enum(["verified", "timeout"]),
  latencyMs: z.number(),
});

const demoAttemptInternalSchema = z.object({
  attempt: z.number(),
  phase: z.enum(["calibration", "adaptive"]),
  routedChannel: channelEnum,
  finalChannel: channelEnum,
  fallbackUsed: z.boolean(),
  verified: z.literal(true),
  timeoutMs: z.number(),
  latencyMs: z.number(),
  primary: demoChannelOutcomeInternalSchema,
  fallback: demoChannelOutcomeInternalSchema.nullable(),
  decisionLog: z.array(decisionLogEntrySchema),
});

const pendingAdaptiveInternalSchema = z.object({
  attempt: z.number(),
  routedChannel: channelEnum,
  fallbackChannel: channelEnum.nullable(),
  reason: z.string(),
  decisionLog: z.array(decisionLogEntrySchema),
  timeoutMs: z.number(),
  startedAtMs: z.number(),
  priorityDeadlineMs: z.number(),
});

const demoSessionStateSchema = z.object({
  calibrationChoices: z.array(channelEnum),
  adaptiveResults: z.array(demoAttemptInternalSchema),
  lastVerifiedChannel: channelEnum.nullable(),
  pendingAdaptive: pendingAdaptiveInternalSchema.nullable(),
});

const channelOutcomeSchema = z.object({
  channel: channelEnum,
  outcome: z.enum(["verified", "timeout", "send_failed"]),
  latency_ms: z.number(),
});

const attemptResponseSchema = z.object({
  attempt: z.number(),
  phase: z.enum(["calibration", "adaptive"]),
  routed_channel: channelEnum,
  final_channel: channelEnum.nullable(),
  fallback_used: z.boolean(),
  verified: z.boolean(),
  timeout_ms: z.number(),
  latency_ms: z.number(),
  primary: channelOutcomeSchema,
  fallback: channelOutcomeSchema.nullable(),
  decision_log: z.array(decisionLogEntrySchema),
});

const pendingResponseSchema = z.object({
  attempt: z.number(),
  routed_channel: channelEnum,
  fallback_channel: channelEnum.nullable(),
  reason: z.string(),
  decision_log: z.array(decisionLogEntrySchema),
  timeout_ms: z.number(),
  started_at_ms: z.number(),
  priority_deadline_ms: z.number(),
});

const phaseCountsSchema = z.object({ completed: z.number(), total: z.number() });

const startResponseSchema = z.object({
  session_id: z.string(),
  phase: z.enum(["calibration", "adaptive", "complete"]),
  calibration: phaseCountsSchema,
  adaptive: phaseCountsSchema,
});

const sessionStateResponseSchema = startResponseSchema.extend({
  attempts: z.array(attemptResponseSchema),
  pending: pendingResponseSchema.nullable(),
});

const reportResponseSchema = z.object({
  calibration: z.array(attemptResponseSchema),
  adaptive: z.array(attemptResponseSchema),
  channel_usage: z.object({ whatsapp: z.number(), sms: z.number() }),
  success_rate: z.object({ whatsapp: z.number(), sms: z.number() }),
  avg_latency_ms: z.object({ whatsapp: z.number().nullable(), sms: z.number().nullable() }),
  fallback_counts: z.object({ whatsapp_to_sms: z.number(), sms_to_whatsapp: z.number() }),
  routing_changes: z.number(),
  fallback_events: z.number(),
  final_channel: channelEnum,
  explanation: z.string(),
});

const calibrationBodySchema = z.object({ channel: channelEnum });
const verifyBodySchema = z.object({ channel: channelEnum });

function retryAfterHeader(retryAfterMs: number): string {
  return String(Math.max(1, Math.ceil(retryAfterMs / 1000)));
}

function toAttemptResponse(attempt: DemoAttempt): z.infer<typeof attemptResponseSchema> {
  return {
    attempt: attempt.attempt,
    phase: attempt.phase,
    routed_channel: attempt.routedChannel,
    final_channel: attempt.finalChannel,
    fallback_used: attempt.fallbackUsed,
    verified: attempt.verified,
    timeout_ms: attempt.timeoutMs,
    latency_ms: attempt.latencyMs,
    primary: {
      channel: attempt.primary.channel,
      outcome: attempt.primary.outcome,
      latency_ms: attempt.primary.latencyMs,
    },
    fallback: attempt.fallback
      ? {
          channel: attempt.fallback.channel,
          outcome: attempt.fallback.outcome,
          latency_ms: attempt.fallback.latencyMs,
        }
      : null,
    decision_log: [...attempt.decisionLog],
  };
}

function toPendingResponse(pending: PendingAdaptiveAttempt): z.infer<typeof pendingResponseSchema> {
  return {
    attempt: pending.attempt,
    routed_channel: pending.routedChannel,
    fallback_channel: pending.fallbackChannel,
    reason: pending.reason,
    decision_log: [...pending.decisionLog],
    timeout_ms: pending.timeoutMs,
    started_at_ms: pending.startedAtMs,
    priority_deadline_ms: pending.priorityDeadlineMs,
  };
}

function toReportResponse(report: DemoReport): z.infer<typeof reportResponseSchema> {
  return {
    calibration: report.calibration.map(toAttemptResponse),
    adaptive: report.adaptive.map(toAttemptResponse),
    channel_usage: report.channelUsage,
    success_rate: report.successRate,
    avg_latency_ms: report.avgLatencyMs,
    fallback_counts: {
      whatsapp_to_sms: report.fallbackCounts.whatsappToSms,
      sms_to_whatsapp: report.fallbackCounts.smsToWhatsapp,
    },
    routing_changes: report.routingChanges,
    fallback_events: report.fallbackEvents,
    final_channel: report.finalChannel,
    explanation: report.explanation,
  };
}

// 30 minutes: long enough for a human to actually click through 3 + 10 attempts with
// pauses to read the trace, short enough that an abandoned session doesn't linger.
const DEMO_ROUTING_SESSION_TTL_SECONDS = 30 * 60;
const DEMO_ROUTING_SESSION_KEY_PREFIX = "demo:routing:";

function sessionRedisKey(sessionId: string): string {
  return `${DEMO_ROUTING_SESSION_KEY_PREFIX}${sessionId}`;
}

/** I6: crypto randomness, never Math.random — the session id is the only credential a
 * client holds for this session; a normal-account session token gets the same
 * treatment in auth/session.ts. */
function generateSessionId(): string {
  return randomBytes(16).toString("base64url");
}

async function saveSession(
  redis: Redis,
  sessionId: string,
  state: DemoSessionState,
): Promise<void> {
  await redis.setex(
    sessionRedisKey(sessionId),
    DEMO_ROUTING_SESSION_TTL_SECONDS,
    JSON.stringify(state),
  );
}

/** The only place this session's state is read from — Redis holds exactly what this
 * module wrote (JSON.parse is safe here precisely because no external input ever
 * reaches this value; a request only ever supplies the lookup key, never the state
 * itself, so the phase/attempt counts this route enforces can't be forged client-side). */
async function loadSession(redis: Redis, sessionId: string): Promise<DemoSessionState | null> {
  const raw = await redis.get(sessionRedisKey(sessionId));
  return raw ? demoSessionStateSchema.parse(JSON.parse(raw)) : null;
}

/**
 * I10: the demo's fallback timeout comes from `DEMO_ACCOUNT_ID`'s own routing policy
 * (seed-demo.ts seeds it at 5s/5s), read fresh on every request — never a hardcoded
 * constant in this route or in packages/simulator. This is the only database read this
 * whole route group performs; there are no writes, no queue jobs, and no plaintext
 * code is ever generated, so the I4 carve-out the old `/v1/demo/*` routes needed does
 * not apply here at all.
 */
async function loadDemoPolicy(pg: PgClient): Promise<RoutingPolicy> {
  const row = await findActiveRoutingPolicy(pg, DEMO_ACCOUNT_ID);
  return row ? routingPolicySchema.parse(row.policyJson) : DEFAULT_ROUTING_POLICY;
}

function phaseCounts(state: DemoSessionState): {
  phase: "calibration" | "adaptive" | "complete";
  calibration: { completed: number; total: number };
  adaptive: { completed: number; total: number };
} {
  return {
    phase: sessionPhase(state),
    calibration: { completed: state.calibrationChoices.length, total: DEMO_CALIBRATION_ATTEMPTS },
    adaptive: { completed: state.adaptiveResults.length, total: DEMO_ADAPTIVE_ATTEMPTS },
  };
}

/**
 * The public /demo/routing dashboard page. Six unauthenticated, hard-rate-limited
 * routes over one seeded session held in Redis (never Postgres — nothing here is a
 * verification, so there's nothing to persist as one). Every routing decision is
 * produced by the exact `buildRoutingPlan` pipeline `/v1/verification/start` calls
 * (via packages/simulator/src/demo-session.ts) against `DEMO_ACCOUNT_ID`'s real routing
 * policy — the demo shows real routing intelligence, not a scripted animation.
 *
 * Registration is conditional on the demo account existing, the same shape as the
 * Google/Meta route groups (app.ts checks this at boot).
 */
export function registerDemoRoutes(app: FastifyInstance, pg: PgClient, redis: Redis): void {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.post(
    "/v1/demo/routing/start",
    {
      schema: {
        body: z.object({}),
        response: { 201: startResponseSchema, 429: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const breach = await checkDemoStartRateLimits(redis, request.ip);
      if (breach) {
        reply.header("Retry-After", retryAfterHeader(breach.retryAfterMs));
        return reply.code(429).send({ error: `rate_limited_${breach.scope}` });
      }

      const state = startSession();
      const sessionId = generateSessionId();
      await saveSession(redis, sessionId, state);

      return reply.code(201).send({ session_id: sessionId, ...phaseCounts(state) });
    },
  );

  server.post(
    "/v1/demo/routing/:sessionId/calibration",
    {
      schema: {
        params: paramsSchema,
        body: calibrationBodySchema,
        response: {
          200: z
            .object({ attempt: attemptResponseSchema, ...startResponseSchema.shape })
            .omit({ session_id: true }),
          404: errorResponseSchema,
          409: errorResponseSchema,
          429: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const actLimit = await checkDemoActRateLimit(redis, request.ip);
      if (!actLimit.allowed) {
        reply.header("Retry-After", retryAfterHeader(actLimit.retryAfterMs));
        return reply.code(429).send({ error: "rate_limited_ip" });
      }

      const { sessionId } = request.params;
      const state = await loadSession(redis, sessionId);
      if (!state) {
        return reply.code(404).send({ error: "not_found" });
      }
      // The browser is never trusted to know or enforce the phase — a request outside
      // calibration (already in adaptive, or already complete) is rejected here, not
      // merely hidden by the UI disabling a button.
      if (sessionPhase(state) !== "calibration") {
        return reply.code(409).send({ error: "not_in_calibration_phase" });
      }

      const policy = await loadDemoPolicy(pg);
      const { state: nextState, attempt } = stepCalibration(policy, state, request.body.channel);
      await saveSession(redis, sessionId, nextState);

      return reply
        .code(200)
        .send({ attempt: toAttemptResponse(attempt), ...phaseCounts(nextState) });
    },
  );

  // §9/§10: decides the priority channel for the next adaptive attempt and parks it as
  // `pendingAdaptive` -- it does not resolve anything. The client learns which single
  // channel it may currently verify through from this response, not from a choice it
  // made itself (§4: there is no body schema here, same as the previous one-shot
  // version — a client cannot request a channel).
  server.post(
    "/v1/demo/routing/:sessionId/attempt",
    {
      schema: {
        params: paramsSchema,
        response: {
          200: z
            .object({ pending: pendingResponseSchema, ...startResponseSchema.shape })
            .omit({ session_id: true }),
          404: errorResponseSchema,
          409: errorResponseSchema,
          429: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const actLimit = await checkDemoActRateLimit(redis, request.ip);
      if (!actLimit.allowed) {
        reply.header("Retry-After", retryAfterHeader(actLimit.retryAfterMs));
        return reply.code(429).send({ error: "rate_limited_ip" });
      }

      const { sessionId } = request.params;
      const state = await loadSession(redis, sessionId);
      if (!state) {
        return reply.code(404).send({ error: "not_found" });
      }
      if (sessionPhase(state) !== "adaptive") {
        return reply.code(409).send({ error: "not_in_adaptive_phase" });
      }
      if (state.pendingAdaptive) {
        return reply.code(409).send({ error: "attempt_already_pending" });
      }

      const policy = await loadDemoPolicy(pg);
      const { state: nextState, pending } = beginAdaptiveAttempt(policy, state, Date.now());
      await saveSession(redis, sessionId, nextState);

      return reply
        .code(200)
        .send({ pending: toPendingResponse(pending), ...phaseCounts(nextState) });
    },
  );

  // §3/§4/§13: the only route that can resolve a pending adaptive attempt. `channel`
  // must be the one currently available — the priority channel before its deadline, the
  // fallback channel at or after it — checked against server-held wall-clock time, not
  // trusted from the client. This is the actual integrity guarantee; the dashboard
  // disabling the other button is only a UI courtesy on top of it.
  server.post(
    "/v1/demo/routing/:sessionId/verify",
    {
      schema: {
        params: paramsSchema,
        body: verifyBodySchema,
        response: {
          200: z
            .object({ attempt: attemptResponseSchema, ...startResponseSchema.shape })
            .omit({ session_id: true }),
          404: errorResponseSchema,
          409: errorResponseSchema,
          429: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const actLimit = await checkDemoActRateLimit(redis, request.ip);
      if (!actLimit.allowed) {
        reply.header("Retry-After", retryAfterHeader(actLimit.retryAfterMs));
        return reply.code(429).send({ error: "rate_limited_ip" });
      }

      const { sessionId } = request.params;
      const state = await loadSession(redis, sessionId);
      if (!state) {
        return reply.code(404).send({ error: "not_found" });
      }
      if (sessionPhase(state) !== "adaptive" || !state.pendingAdaptive) {
        return reply.code(409).send({ error: "no_pending_attempt" });
      }

      let nextState: DemoSessionState;
      let attempt: DemoAttempt;
      try {
        ({ state: nextState, attempt } = verifyAdaptiveChannel(
          state,
          request.body.channel,
          Date.now(),
        ));
      } catch {
        return reply.code(409).send({ error: "channel_not_available" });
      }
      await saveSession(redis, sessionId, nextState);

      return reply
        .code(200)
        .send({ attempt: toAttemptResponse(attempt), ...phaseCounts(nextState) });
    },
  );

  server.get(
    "/v1/demo/routing/:sessionId",
    {
      schema: {
        params: paramsSchema,
        response: {
          200: sessionStateResponseSchema,
          404: errorResponseSchema,
          429: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const readLimit = await checkDemoReadRateLimit(redis, request.ip);
      if (!readLimit.allowed) {
        reply.header("Retry-After", retryAfterHeader(readLimit.retryAfterMs));
        return reply.code(429).send({ error: "rate_limited_ip" });
      }

      const { sessionId } = request.params;
      const state = await loadSession(redis, sessionId);
      if (!state) {
        return reply.code(404).send({ error: "not_found" });
      }

      const policy = await loadDemoPolicy(pg);
      const { attempts } = replaySession(policy, state);

      return reply.code(200).send({
        session_id: sessionId,
        ...phaseCounts(state),
        attempts: attempts.map(toAttemptResponse),
        pending: state.pendingAdaptive ? toPendingResponse(state.pendingAdaptive) : null,
      });
    },
  );

  server.get(
    "/v1/demo/routing/:sessionId/report",
    {
      schema: {
        params: paramsSchema,
        response: {
          200: reportResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          429: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const readLimit = await checkDemoReadRateLimit(redis, request.ip);
      if (!readLimit.allowed) {
        reply.header("Retry-After", retryAfterHeader(readLimit.retryAfterMs));
        return reply.code(429).send({ error: "rate_limited_ip" });
      }

      const { sessionId } = request.params;
      const state = await loadSession(redis, sessionId);
      if (!state) {
        return reply.code(404).send({ error: "not_found" });
      }
      if (sessionPhase(state) !== "complete") {
        return reply.code(409).send({ error: "session_not_complete" });
      }

      const policy = await loadDemoPolicy(pg);
      const { attempts } = replaySession(policy, state);
      const report = buildDemoReport(attempts);

      return reply.code(200).send(toReportResponse(report));
    },
  );
}
