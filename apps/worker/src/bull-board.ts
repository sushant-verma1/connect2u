import Fastify, { type FastifyInstance } from "fastify";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { FastifyAdapter } from "@bull-board/fastify";
import type { Queue } from "bullmq";
import type { SimulatedProvider } from "@otp-router/providers/simulated";

/**
 * Dev-only queue inspection (ARCHITECTURE.md §2 / TECHSTACK.md) plus the outbox
 * endpoint below. Neither is ever mounted in production — this whole Fastify instance
 * is only constructed when `config.nodeEnv === "development"` (apps/worker/src/index.ts).
 */
export async function startBullBoard(
  queues: readonly Queue[],
  port: number,
  simulatedProvider: SimulatedProvider,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const serverAdapter = new FastifyAdapter();
  serverAdapter.setBasePath("/admin/queues");

  createBullBoard({
    queues: queues.map((queue) => new BullMQAdapter(queue)),
    serverAdapter,
  });

  await app.register(serverAdapter.registerPlugin(), { prefix: "/admin/queues" });

  // R2.2/R7.2: the server never exposes a plaintext code anywhere else — this is the
  // one deliberate exception, gated the same way Bull Board is, and it's an HTTP
  // response body, never a log line. Mirrors how a Twilio/Meta sandbox lets you
  // inspect an outbound message during manual testing: something to look at, not
  // something reconstructed from the stored hash.
  app.get<{ Querystring: { phone_number?: string } }>("/dev/outbox", async (request) => {
    const { phone_number: phoneNumber } = request.query;
    const sent = simulatedProvider.sentWithProviderIds;
    return phoneNumber ? sent.filter((message) => message.phoneNumber === phoneNumber) : sent;
  });

  await app.listen({ port, host: "0.0.0.0" });
  return app;
}
