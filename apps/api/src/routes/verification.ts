import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
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
import { CHECK_OUTCOMES } from "@otp-router/core/state-machine/check-outcome";
import { buildChannelChain } from "@otp-router/core/fallback/channel-chain";
import { fallbackTimerJobId } from "@otp-router/core/queue/fallback-job";
import type { ApiKeyAuth } from "../auth/api-key-auth.js";
import { encryptCode } from "../crypto/code-encryption.js";
import { generateCode } from "../crypto/code.js";
import { hmacHex } from "../crypto/hmac.js";
import { hashPhone, normalizePhoneNumber } from "../crypto/phone.js";
import { encryptPhone } from "../crypto/phone-encryption.js";
import { checkVerification } from "../services/check-verification.js";
import type { Config } from "../config.js";
import type { Queues } from "../queue/queues.js";

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
  channel_verified: z.string().optional(),
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
  channel_verified: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export function registerVerificationRoutes(
  app: FastifyInstance,
  pg: PgClient,
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
        response: { 202: startResponseSchema, 401: errorResponseSchema, 422: errorResponseSchema },
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

      const code = generateCode(body.code_length);
      const expiresAt = new Date(Date.now() + body.ttl_seconds * 1000);
      const verificationId = `ver_${ulid()}`;
      // R4.7: the ordered, capped chain this verification will fall back through.
      const channelChain = buildChannelChain(body.channels);
      const firstChannel = channelChain[0];
      if (!firstChannel) {
        return reply.code(422).send({ error: "no_channel_available" });
      }

      await insertVerification(pg, {
        id: verificationId,
        accountId: request.account.id,
        phoneHash: hashPhone(normalizedPhone, config.phoneHashPepper),
        phoneEncrypted: encryptPhone(normalizedPhone, config.phoneEncryptionKey),
        codeHmac: hmacHex(code, config.otpPepper),
        // R2.3: encrypted, not hashed — this is what lets a later channel in the chain
        // resend the exact same code (a fallback must never regenerate it).
        codeEncrypted: encryptCode(code, config.codeEncryptionKey),
        channelChain: [...channelChain],
        expiresAt,
        metadataJson: body.metadata ?? {},
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
        channel_verified: result.verification?.verifiedChannel ?? undefined,
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
        channel_verified: verification.verifiedChannel ?? undefined,
        metadata: verification.metadataJson,
      });
    },
  );
}
