import Fastify, { type FastifyInstance } from "fastify";
import helmet from "@fastify/helmet";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import type { PgClient } from "@otp-router/db/client";
import { MetaProvider } from "@otp-router/providers/meta";
import type { Redis } from "ioredis";
import type { Config } from "./config.js";
import { createApiKeyAuth } from "./auth/api-key-auth.js";
import { registerCorrelationId } from "./plugins/correlation-id.js";
import { closeQueues, createQueues } from "./queue/queues.js";
import { registerDeadLetterRoutes } from "./routes/dead-letters.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerMetaWebhookRoutes } from "./routes/meta-webhook.js";
import { registerRoutingPolicyRoutes } from "./routes/routing-policy.js";
import { registerVerificationRoutes } from "./routes/verification.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";

export async function buildApp(
  config: Config,
  pg: PgClient,
  redis: Redis,
  bullConnection: Redis,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      transport: config.nodeEnv === "development" ? { target: "pino-pretty" } : undefined,
    },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const queues = createQueues(bullConnection);
  app.addHook("onClose", () => closeQueues(queues));

  await app.register(helmet);
  registerCorrelationId(app);
  registerHealthRoutes(app, pg, redis);

  // Shared across every route group so the auth cache (api-key-auth.ts) actually pays
  // off instead of each route group re-verifying the same key on its own miss.
  const apiKeyAuth = createApiKeyAuth(pg, config.apiKeyPepper);
  registerVerificationRoutes(app, pg, queues, apiKeyAuth, config);
  registerDeadLetterRoutes(app, queues.deadLetterQueue, apiKeyAuth);
  registerWebhookRoutes(app, queues.webhookIngestQueue);
  registerRoutingPolicyRoutes(app, pg, apiKeyAuth);

  // Only registered once Meta credentials exist — there's nothing to verify a
  // signature against otherwise, and an unconfigured webhook endpoint is worse than a
  // missing one (PROJECT.md: WhatsApp is a simulated channel until then).
  if (config.metaAppSecret && config.metaWebhookVerifyToken) {
    const metaProvider = new MetaProvider({
      phoneNumberId: config.metaPhoneNumberId ?? "",
      accessToken: config.metaAccessToken ?? "",
      appSecret: config.metaAppSecret,
      templateName: config.metaTemplateName,
    });
    registerMetaWebhookRoutes(
      app,
      queues.webhookIngestQueue,
      metaProvider,
      config.metaWebhookVerifyToken,
    );
  }

  return app;
}
