import type { FastifyInstance } from "fastify";
import type { Queue } from "bullmq";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { DeadLetterRecord } from "@otp-router/core/queue/delivery-job";
import type { ApiKeyAuth } from "../auth/api-key-auth.js";

const deadLetterSchema = z.object({
  attemptId: z.string(),
  verificationId: z.string(),
  accountId: z.string(),
  channel: z.string(),
  errorCode: z.string(),
  errorMessage: z.string(),
  attemptsMade: z.number(),
  failedAt: z.string(),
  correlationId: z.string(),
});

const listResponseSchema = z.object({ dead_letters: z.array(deadLetterSchema) });
const errorResponseSchema = z.object({ error: z.string() });

/** R4.9: the delivery DLQ is never processed — it exists purely as an inspectable list. */
export function registerDeadLetterRoutes(
  app: FastifyInstance,
  deadLetterQueue: Queue<DeadLetterRecord>,
  apiKeyAuth: ApiKeyAuth,
): void {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    "/v1/admin/delivery/dead-letters",
    {
      preHandler: apiKeyAuth,
      schema: {
        response: { 200: listResponseSchema, 401: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const jobs = await deadLetterQueue.getJobs(["waiting"]);
      const deadLetters = jobs
        .map((job) => job.data)
        // R8.1: scoped by account even though the DLQ itself is global.
        .filter((record) => record.accountId === request.account.id);

      return reply.code(200).send({ dead_letters: deadLetters });
    },
  );
}
