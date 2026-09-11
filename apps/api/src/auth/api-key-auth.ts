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

/** R8.1: every route behind this hook gets a scoped account before it touches data. */
export function createApiKeyAuth(pg: PgClient, apiKeyPepper: string) {
  return async function apiKeyAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = request.headers.authorization;
    if (!header || !header.startsWith(BEARER_PREFIX)) {
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }

    const fullKey = header.slice(BEARER_PREFIX.length);
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
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }

    request.account = account;
  };
}
