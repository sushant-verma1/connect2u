import type { FastifyReply, FastifyRequest } from "fastify";
import type { PgClient } from "@otp-router/db/client";
import type { Account } from "@otp-router/db/repositories/accounts";
import {
  findAccountByApiKeyPrefix,
  touchApiKeyLastUsed,
} from "@otp-router/db/repositories/api-keys";
import { apiKeyPrefix, verifyApiKey } from "../crypto/api-key.js";

declare module "fastify" {
  interface FastifyRequest {
    account: Account;
    apiKeyId: string;
  }
}

const BEARER_PREFIX = "Bearer ";

// R7.4/PROJECT.md "Security posture": argon2 is the *correct* primitive for API keys —
// unlike a 6-digit OTP, a leaked hash is worth attacking, so slow hashing earns its
// keep. But that cost is meant to be paid once per key, not once per request. Caching
// the outcome in-process, keyed on the full key (not just the prefix — the prefix only
// identifies the row, it doesn't prove the secret matched), keeps argon2 at full
// strength while keeping it off the hot path. A revoked or suspended key stays valid
// for up to `AUTH_CACHE_TTL_MS` after revocation on *other* instances — `invalidateKey`
// (R13.5) closes this on the instance that served the revoke, immediately.
const AUTH_CACHE_TTL_MS = 30_000;

type CachedAuth = Readonly<{ account: Account; apiKeyId: string; expiresAt: number }>;

export type ApiKeyAuth = ReturnType<typeof createApiKeyAuth>["apiKeyAuth"];

/** R8.1: every route behind this hook gets a scoped account before it touches data. */
export function createApiKeyAuth(pg: PgClient, apiKeyPepper: string) {
  const cache = new Map<string, CachedAuth>();

  const apiKeyAuth = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
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
      request.apiKeyId = cached.apiKeyId;
      return;
    }

    const prefix = apiKeyPrefix(fullKey);
    if (!prefix) {
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }

    const found = await findAccountByApiKeyPrefix(pg, prefix);
    if (!found) {
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }

    const { account, apiKey } = found;
    const valid = await verifyApiKey(fullKey, apiKeyPepper, apiKey.keyHash);
    if (!valid || account.status !== "active") {
      cache.delete(fullKey);
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }

    cache.set(fullKey, { account, apiKeyId: apiKey.id, expiresAt: Date.now() + AUTH_CACHE_TTL_MS });
    // Only on a cache miss — one write per key per `AUTH_CACHE_TTL_MS`, not one per
    // request. Not awaited: last_used_at is informational, not on the auth-decision path.
    void touchApiKeyLastUsed(pg, apiKey.id);
    request.account = account;
    request.apiKeyId = apiKey.id;
  };

  // R13.5: DELETE /v1/keys/:id calls this so the revoking instance stops honouring the
  // key immediately instead of waiting out the full 30s cache window (README states the
  // bound for every *other* instance). ponytail: O(n) scan over this instance's cached
  // keys — cache sizes here are "keys touched by this process recently", not the full
  // table; upgrade to an id-keyed second map if that stops being true.
  const invalidateKey = (apiKeyId: string): void => {
    for (const [fullKey, entry] of cache) {
      if (entry.apiKeyId === apiKeyId) {
        cache.delete(fullKey);
      }
    }
  };

  return { apiKeyAuth, invalidateKey };
}
