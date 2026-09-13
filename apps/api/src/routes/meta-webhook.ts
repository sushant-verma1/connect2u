import type { FastifyInstance } from "fastify";
import type { Queue } from "bullmq";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Provider } from "@otp-router/providers/provider";
import type { WebhookIngestJobData } from "@otp-router/core/queue/webhook-job";

const handshakeQuerySchema = z.object({
  "hub.mode": z.string().optional(),
  "hub.verify_token": z.string().optional(),
  "hub.challenge": z.string().optional(),
});

const acceptedResponseSchema = z.object({ accepted: z.literal(true) });
const errorResponseSchema = z.object({ error: z.string() });

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * R6.1: verify → dedupe → 200 → queue, for the real Meta Cloud API webhook. The
 * signature check happens inside the content-type parser registered below, which runs
 * before Fastify's default JSON parser and before Zod validation — the ordering is the
 * security property, not just the presence of a check. Dedupe (R6.2) is the
 * `webhook_events` unique index, same as `/v1/webhooks/simulated`.
 */
export function registerMetaWebhookRoutes(
  app: FastifyInstance,
  webhookIngestQueue: Queue<WebhookIngestJobData>,
  provider: Provider,
  webhookVerifyToken: string,
): void {
  app.register(async (scoped) => {
    scoped.addContentTypeParser<Buffer>(
      "application/json",
      { parseAs: "buffer" },
      (request, rawBody, done) => {
        const header = request.headers["x-hub-signature-256"];
        const signatureHeader = Array.isArray(header) ? header[0] : header;

        if (!provider.verifySignature(rawBody, signatureHeader)) {
          done(Object.assign(new Error("invalid signature"), { statusCode: 401 }));
          return;
        }

        try {
          done(null, JSON.parse(rawBody.toString("utf8")));
        } catch {
          done(Object.assign(new Error("invalid JSON body"), { statusCode: 400 }));
        }
      },
    );

    const server = scoped.withTypeProvider<ZodTypeProvider>();

    // Meta's one-time subscription handshake — no signature to verify, just the shared
    // verify token from the app dashboard.
    server.get(
      "/v1/webhooks/meta",
      {
        schema: {
          querystring: handshakeQuerySchema,
          response: { 200: z.string(), 403: errorResponseSchema },
        },
      },
      async (request, reply) => {
        const query = request.query;
        if (
          query["hub.mode"] !== "subscribe" ||
          !query["hub.verify_token"] ||
          !timingSafeStringEqual(query["hub.verify_token"], webhookVerifyToken)
        ) {
          return reply.code(403).send({ error: "verification_failed" });
        }
        return reply.code(200).send(query["hub.challenge"] ?? "");
      },
    );

    server.post(
      "/v1/webhooks/meta",
      { schema: { response: { 200: acceptedResponseSchema } } },
      async (request, reply) => {
        const events = provider.parseWebhook(request.body);
        await Promise.all(
          events.map((event) =>
            webhookIngestQueue.add("ingest", {
              provider: "meta",
              providerMessageId: event.providerMessageId,
              eventType: event.eventType,
              payload: event.payload,
              correlationId: request.correlationId,
              // Reaching this point already required verifySignature to pass (R6.1).
              signatureValid: true,
            }),
          ),
        );
        return reply.code(200).send({ accepted: true });
      },
    );
  });
}
