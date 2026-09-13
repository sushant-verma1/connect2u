import type { FastifyInstance } from "fastify";
import type { Queue } from "bullmq";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { WebhookIngestJobData } from "@otp-router/core/queue/webhook-job";

const simulatedWebhookBodySchema = z.object({
  provider_message_id: z.string().min(1),
  event_type: z.enum(["delivered", "failed"]),
});

const acceptedResponseSchema = z.object({ accepted: z.literal(true) });

/**
 * R6.4: verify → dedupe → 200 within 500ms, process on queue. There is no signature to
 * verify here — `SimulatedProvider` has no signature scheme, unlike Meta's
 * `X-Hub-Signature-256` (R6.1, Phase 4's `/v1/webhooks/meta`). Dedupe (R6.2) happens in
 * the queue processor via the `webhook_events` unique index, not here — one
 * authoritative check under a DB constraint beats a fast-path check plus a backstop.
 */
export function registerWebhookRoutes(
  app: FastifyInstance,
  webhookIngestQueue: Queue<WebhookIngestJobData>,
): void {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.post(
    "/v1/webhooks/simulated",
    { schema: { body: simulatedWebhookBodySchema, response: { 200: acceptedResponseSchema } } },
    async (request, reply) => {
      const body = request.body;

      await webhookIngestQueue.add("ingest", {
        provider: "simulated",
        providerMessageId: body.provider_message_id,
        eventType: body.event_type,
        payload: body,
        correlationId: request.correlationId,
        signatureValid: null,
      });

      return reply.code(200).send({ accepted: true });
    },
  );
}
