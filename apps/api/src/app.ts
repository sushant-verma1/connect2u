import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import swagger from "@fastify/swagger";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import type { PgClient } from "@otp-router/db/client";
import { MetaProvider } from "@otp-router/providers/meta";
import type { Redis } from "ioredis";
import type { Config } from "./config.js";
import { createApiKeyAuth } from "./auth/api-key-auth.js";
import { createSessionAuth } from "./auth/session.js";
import { registerCorrelationId } from "./plugins/correlation-id.js";
import { closeQueues, createQueues } from "./queue/queues.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerGoogleAuthRoutes } from "./routes/auth-google.js";
import { registerDeadLetterRoutes } from "./routes/dead-letters.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerKeysRoutes } from "./routes/keys.js";
import { registerMetaWebhookRoutes } from "./routes/meta-webhook.js";
import { registerRoutingPolicyRoutes } from "./routes/routing-policy.js";
import { registerVerificationRoutes, registerDashboardTraceRoute } from "./routes/verification.js";
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
  // R13.2: signing is skipped deliberately — the session token itself is 32 random
  // bytes (session.ts), already unguessable and never client-readable data, so a
  // signature over it would only protect against tampering with a value the client
  // can't meaningfully tamper with anyway.
  await app.register(cookie);
  // Phase 8: the dashboard (a separate Vite origin) reads this API directly — no BFF
  // (ARCHITECTURE.md). Scoped to one configured origin, not `*`, since every route
  // here is Bearer-authenticated and a wildcard origin would let any page in a user's
  // browser replay a stolen key's requests cross-origin. R13.2: cookies are never sent
  // cross-origin regardless (no `credentials: true` here, and the dashboard proxies
  // `/v1` same-origin — see nginx.conf.template/vite.config.ts) — this CORS allowance
  // is for the Bearer-authenticated routes only.
  await app.register(cors, { origin: config.dashboardOrigin });
  // The spec is generated from the same Zod schemas every route already validates
  // against (`transform: jsonSchemaTransform`) — there is no second, hand-maintained
  // description of the API to drift out of sync with the actual routes.
  await app.register(swagger, {
    openapi: {
      info: { title: "otp-router", version: "0.0.0" },
    },
    transform: jsonSchemaTransform,
  });
  app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());
  registerCorrelationId(app);
  registerHealthRoutes(app, pg, redis);

  // Shared across every route group so the auth cache (api-key-auth.ts) actually pays
  // off instead of each route group re-verifying the same key on its own miss.
  // `invalidateKey` is handed to the keys route (R13.5) so a revoke drops this
  // instance's cache entry immediately, ahead of the 30s TTL.
  const { apiKeyAuth, invalidateKey } = createApiKeyAuth(pg, config.apiKeyPepper);
  registerVerificationRoutes(app, pg, redis, queues, apiKeyAuth, config);
  registerDeadLetterRoutes(app, queues.deadLetterQueue, apiKeyAuth);
  registerWebhookRoutes(app, queues.webhookIngestQueue);
  registerRoutingPolicyRoutes(app, pg, apiKeyAuth);

  // R13.2: the dashboard's credential — disjoint route set from apiKeyAuth's (§2 of
  // the report: a session never authenticates a verification endpoint, an API key
  // never authenticates a dashboard route).
  const sessionAuth = createSessionAuth(pg, redis);
  registerAuthRoutes(app, pg, redis, config, sessionAuth);
  registerKeysRoutes(app, pg, sessionAuth, invalidateKey, config);
  registerDashboardTraceRoute(app, pg, sessionAuth);

  // R13.7: only registered once both Google credentials exist, same conditional shape
  // as the Meta webhook below — a Google-less local dev environment still boots.
  if (config.googleClientId && config.googleClientSecret) {
    registerGoogleAuthRoutes(
      app,
      pg,
      redis,
      config,
      config.googleClientId,
      config.googleClientSecret,
    );
  }

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

  if (config.nodeEnv === "development") {
    app.ready(() => {
      app.log.info(`\n${app.printRoutes()}`);
    });
  }

  return app;
}
