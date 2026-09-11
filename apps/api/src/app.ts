import Fastify, { type FastifyInstance } from "fastify";
import helmet from "@fastify/helmet";
import type { PgClient } from "@otp-router/db";
import type { Redis } from "ioredis";
import type { Config } from "./config.js";
import { registerCorrelationId } from "./plugins/correlation-id.js";
import { registerHealthRoutes } from "./routes/health.js";

export async function buildApp(
  config: Config,
  pg: PgClient,
  redis: Redis,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      transport: config.nodeEnv === "development" ? { target: "pino-pretty" } : undefined,
    },
  });

  await app.register(helmet);
  registerCorrelationId(app);
  registerHealthRoutes(app, pg, redis);

  return app;
}
