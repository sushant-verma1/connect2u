import Fastify, { type FastifyInstance } from "fastify";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { FastifyAdapter } from "@bull-board/fastify";
import type { Queue } from "bullmq";

/** Dev-only queue inspection (ARCHITECTURE.md §2 / TECHSTACK.md). Never mounted in production. */
export async function startBullBoard(
  queues: readonly Queue[],
  port: number,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const serverAdapter = new FastifyAdapter();
  serverAdapter.setBasePath("/admin/queues");

  createBullBoard({
    queues: queues.map((queue) => new BullMQAdapter(queue)),
    serverAdapter,
  });

  await app.register(serverAdapter.registerPlugin(), { prefix: "/admin/queues" });
  await app.listen({ port, host: "0.0.0.0" });
  return app;
}
