import type { FastifyInstance } from "fastify";
import type { PgClient } from "@otp-router/db";
import { pingPg } from "@otp-router/db";
import type { Redis } from "ioredis";

export function registerHealthRoutes(app: FastifyInstance, pg: PgClient, redis: Redis): void {
  app.get("/health", async () => {
    return { status: "ok" };
  });

  app.get("/ready", async (request, reply) => {
    const [pgResult, redisResult] = await Promise.allSettled([pingPg(pg), redis.ping()]);

    const pgOk = pgResult.status === "fulfilled";
    const redisOk = redisResult.status === "fulfilled";

    if (!pgOk) {
      request.log.error({ err: pgResult.reason }, "postgres readiness check failed");
    }
    if (!redisOk) {
      request.log.error({ err: redisResult.reason }, "redis readiness check failed");
    }

    if (!pgOk || !redisOk) {
      return reply.code(503).send({ status: "not_ready", postgres: pgOk, redis: redisOk });
    }

    return { status: "ready", postgres: true, redis: true };
  });
}
