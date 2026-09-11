import type { FastifyInstance } from "fastify";
import { ulid } from "ulid";
import { z } from "zod";
import type { PgClient } from "@otp-router/db/client";
import {
  insertVerification,
  findVerificationScoped,
} from "@otp-router/db/repositories/verifications";
import { insertDeliveryAttempt } from "@otp-router/db/repositories/delivery-attempts";
import type { Provider } from "@otp-router/providers/provider";
import { createApiKeyAuth } from "../auth/api-key-auth.js";
import { generateCode } from "../crypto/code.js";
import { hmacHex } from "../crypto/hmac.js";
import { hashPhone, normalizePhoneNumber } from "../crypto/phone.js";
import { encryptPhone } from "../crypto/phone-encryption.js";
import { checkVerification } from "../services/check-verification.js";
import type { Config } from "../config.js";

// Phase 1 sends on a single fixed channel — the routing engine (R3) arrives in Phase 5.
const CHANNEL = "whatsapp" as const;
const MAX_METADATA_BYTES = 4096;

const startBodySchema = z.object({
  phone_number: z.string().min(1),
  channels: z.array(z.enum(["whatsapp", "sms"])).optional(),
  locale: z.string().optional(),
  code_length: z.number().int().min(4).max(8).default(6),
  ttl_seconds: z.number().int().min(60).max(900).default(300),
  metadata: z.record(z.unknown()).optional(),
});

const checkBodySchema = z.object({
  verification_id: z.string().min(1),
  code: z.string().min(1),
});

export function registerVerificationRoutes(
  app: FastifyInstance,
  pg: PgClient,
  provider: Provider,
  config: Config,
): void {
  const apiKeyAuth = createApiKeyAuth(pg, config.apiKeyPepper);

  app.post("/v1/verification/start", { preHandler: apiKeyAuth }, async (request, reply) => {
    const parsed = startBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(422).send({ error: "validation_error", details: parsed.error.issues });
    }
    const body = parsed.data;

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

    await insertVerification(pg, {
      id: verificationId,
      accountId: request.account.id,
      phoneHash: hashPhone(normalizedPhone, config.phoneHashPepper),
      phoneEncrypted: encryptPhone(normalizedPhone, config.phoneEncryptionKey),
      codeHmac: hmacHex(code, config.otpPepper),
      expiresAt,
      metadataJson: body.metadata ?? {},
    });

    const attemptId = `att_${ulid()}`;
    try {
      const sendResult = await provider.send({
        phoneNumber: normalizedPhone,
        code,
        channel: CHANNEL,
      });
      await insertDeliveryAttempt(pg, {
        id: attemptId,
        verificationId,
        accountId: request.account.id,
        channel: CHANNEL,
        provider: "simulated",
        providerMessageId: sendResult.providerMessageId,
        status: "sent",
        sentAt: new Date(),
      });
    } catch {
      // R5.6 / I4: the failure is recorded, never thrown back to the caller — fallback
      // logic lands in Phase 3. /start still returns 202; delivery is best-effort here.
      await insertDeliveryAttempt(pg, {
        id: attemptId,
        verificationId,
        accountId: request.account.id,
        channel: CHANNEL,
        provider: "simulated",
        status: "failed",
        errorCode: "provider_error",
        failedAt: new Date(),
      });
    }

    return reply.code(202).send({
      verification_id: verificationId,
      status: "pending",
      channel_attempted: CHANNEL,
      expires_at: expiresAt.toISOString(),
    });
  });

  app.post("/v1/verification/check", { preHandler: apiKeyAuth }, async (request, reply) => {
    const parsed = checkBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(422).send({ error: "validation_error", details: parsed.error.issues });
    }
    const body = parsed.data;

    const result = await checkVerification(pg, {
      verificationId: body.verification_id,
      accountId: request.account.id,
      code: body.code,
      otpPepper: config.otpPepper,
    });

    return reply.code(200).send({
      verification_id: body.verification_id,
      status: result.outcome,
      channel_verified: result.verification?.verifiedChannel ?? undefined,
      attempts_used: result.verification?.attemptsUsed,
      metadata: result.verification?.metadataJson,
    });
  });

  app.get<{ Params: { id: string } }>(
    "/v1/verification/:id",
    { preHandler: apiKeyAuth },
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
