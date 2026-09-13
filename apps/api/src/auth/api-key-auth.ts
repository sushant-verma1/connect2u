import type { FastifyReply, FastifyRequest } from "fastify";
import type { PgClient } from "@otp-router/db/client";
import type { Account } from "@otp-router/db/repositories/accounts";
import { findAccountByApiKeyPrefix } from "@otp-router/db/repositories/accounts";
import { apiKeyPrefix, verifyApiKey } from "../crypto/api-key.js";

declare module "fastify" {
  interface FastifyRequest {
    account: Account;
  }
}

const BEARER_PREFIX = "Bearer ";

// R7.4/PROJECT.md "Security posture": argon2 is the *correct* primitive for API keys —
// unlike a 6-digit OTP, a leaked hash is worth attacking, so slow hashing earns its
// keep. But that cost is meant to be paid once per key, not once per request. Caching
// the outcome in-process, keyed on the full key (not just the prefix — the prefix only
// identifies the row, it doesn't prove the secret matched), keeps argon2 at full
// strength while keeping it off the hot path. A revoked or suspended key stays valid
// for up to `AUTH_CACHE_TTL_MS` after revocation — a bounded, documented trade-off, not
// a silent one.
const AUTH_CACHE_TTL_MS = 30_000;

type CachedAuth = Readonly<{ account: Account; expiresAt: number }>;

export type ApiKeyAuth = ReturnType<typeof createApiKeyAuth>;

/** R8.1: every route behind this hook gets a scoped account before it touches data. */
export function createApiKeyAuth(pg: PgClient, apiKeyPepper: string) {
  const cache = new Map<string, CachedAuth>();

  return async function apiKeyAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = request.headers.authorization;
    if (!header || !header.startsWith(BEARER_PREFIX)) {
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }

    const fullKey = header.slice(BEARER_PREFIX.length);

    const cached = cache.get(fullKey);
    if (cached && cached.expiresAt > Date.now()) {
      if (cached.account.status !== "active") {
        await reply.code(401).send({ error: "unauthorized" });
        return;
      }
      request.account = cached.account;
      return;
    }

    const prefix = apiKeyPrefix(fullKey);
    if (!prefix) {
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }

    const account = await findAccountByApiKeyPrefix(pg, prefix);
    if (!account) {
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }

    const valid = await verifyApiKey(fullKey, apiKeyPepper, account.apiKeyHash);
    if (!valid || account.status !== "active") {
      cache.delete(fullKey);
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }

    cache.set(fullKey, { account, expiresAt: Date.now() + AUTH_CACHE_TTL_MS });
    request.account = account;
  };
}
