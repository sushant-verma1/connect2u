import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { ulid } from "ulid";
import { z } from "zod";
import type { PgClient } from "@otp-router/db/client";
import { insertApiKey, listApiKeys, revokeApiKey } from "@otp-router/db/repositories/api-keys";
import { generateApiKey, hashApiKey } from "../crypto/api-key.js";
import type { SessionAuth } from "../auth/session.js";
import type { Config } from "../config.js";

const errorResponseSchema = z.object({ error: z.string() });

// R13.3: prefix, created_at, last_used_at — never the full key, never the hash.
const keySchema = z.object({
  id: z.string(),
  prefix: z.string(),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
});

const listResponseSchema = z.object({ keys: z.array(keySchema) });
const createResponseSchema = keySchema.extend({ api_key: z.string() });
const revokeParamsSchema = z.object({ id: z.string().min(1) });

// R13.5: the auth cache's documented lag (api-key-auth.ts's AUTH_CACHE_TTL_MS) — the
// revoking instance drops its own cache entry immediately (invalidateKey), but a
// multi-instance deploy can still serve the key from another instance's cache for up
// to this long. Surfaced here rather than left for the dashboard to discover.
const AUTH_CACHE_TTL_SECONDS = 30;

export function registerKeysRoutes(
  app: FastifyInstance,
  pg: PgClient,
  sessionAuth: SessionAuth,
  invalidateKey: (apiKeyId: string) => void,
  config: Config,
): void {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    "/v1/keys",
    {
      preHandler: sessionAuth,
      schema: { response: { 200: listResponseSchema, 401: errorResponseSchema } },
    },
    async (request, reply) => {
      const rows = await listApiKeys(pg, request.account.id);
      return reply.code(200).send({
        keys: rows.map((row) => ({
          id: row.id,
          prefix: row.keyPrefix,
          created_at: row.createdAt.toISOString(),
          last_used_at: row.lastUsedAt?.toISOString() ?? null,
        })),
      });
    },
  );

  server.post(
    "/v1/keys",
    {
      preHandler: sessionAuth,
      schema: { response: { 201: createResponseSchema, 401: errorResponseSchema } },
    },
    async (request, reply) => {
      const { fullKey, prefix } = generateApiKey("test");
      const keyHash = await hashApiKey(fullKey, config.apiKeyPepper);
      const row = await insertApiKey(pg, {
        id: `key_${ulid()}`,
        accountId: request.account.id,
        keyHash,
        keyPrefix: prefix,
      });
      return reply.code(201).send({
        id: row.id,
        prefix: row.keyPrefix,
        created_at: row.createdAt.toISOString(),
        last_used_at: null,
        api_key: fullKey,
      });
    },
  );

  server.delete(
    "/v1/keys/:id",
    {
      preHandler: sessionAuth,
      schema: {
        params: revokeParamsSchema,
        response: {
          200: z.object({ revoked: z.literal(true), cache_ttl_seconds: z.number() }),
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const revoked = await revokeApiKey(pg, request.params.id, request.account.id);
      if (!revoked) {
        return reply.code(404).send({ error: "not_found" });
      }
      // R13.5: closes the gap on this instance now — the 30s figure returned below is
      // the bound on every *other* instance, not this one.
      invalidateKey(revoked.id);
      return reply.code(200).send({ revoked: true, cache_ttl_seconds: AUTH_CACHE_TTL_SECONDS });
    },
  );
}
