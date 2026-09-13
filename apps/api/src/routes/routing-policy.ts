import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { ulid } from "ulid";
import { z } from "zod";
import type { PgClient } from "@otp-router/db/client";
import {
  activateRoutingPolicy,
  findActiveRoutingPolicy,
} from "@otp-router/db/repositories/routing-policies";
import { DEFAULT_ROUTING_POLICY, routingPolicySchema } from "@otp-router/core/routing/policy";
import type { ApiKeyAuth } from "../auth/api-key-auth.js";

const policyResponseSchema = z.object({
  version: z.number(),
  active: z.boolean(),
  policy: routingPolicySchema,
});

/**
 * R3.1/R3.3: declarative, versioned, per-account routing policy — GET reads whatever is
 * active right now, PUT activates a new version. Both are plain reads/writes against
 * Postgres; there is no deploy or restart involved in either direction, which is the
 * whole point (R3.3).
 */
export function registerRoutingPolicyRoutes(
  app: FastifyInstance,
  pg: PgClient,
  apiKeyAuth: ApiKeyAuth,
): void {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    "/v1/accounts/me/routing-policy",
    { preHandler: apiKeyAuth, schema: { response: { 200: policyResponseSchema } } },
    async (request, reply) => {
      const row = await findActiveRoutingPolicy(pg, request.account.id);
      if (!row) {
        return reply.code(200).send({ version: 0, active: true, policy: DEFAULT_ROUTING_POLICY });
      }
      return reply.code(200).send({
        version: row.version,
        active: row.active,
        policy: routingPolicySchema.parse(row.policyJson),
      });
    },
  );

  server.put(
    "/v1/accounts/me/routing-policy",
    {
      preHandler: apiKeyAuth,
      schema: { body: routingPolicySchema, response: { 200: policyResponseSchema } },
    },
    async (request, reply) => {
      const row = await activateRoutingPolicy(pg, {
        id: `rtp_${ulid()}`,
        accountId: request.account.id,
        policyJson: request.body,
      });
      return reply.code(200).send({
        version: row.version,
        active: row.active,
        policy: routingPolicySchema.parse(row.policyJson),
      });
    },
  );
}
