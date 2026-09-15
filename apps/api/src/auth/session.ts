import { randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { PgClient } from "@otp-router/db/client";
import { findAccountById } from "@otp-router/db/repositories/accounts";
import type { Redis } from "ioredis";
import type { Config } from "../config.js";

export const SESSION_COOKIE_NAME = "sid";

// R13.4: short TTL — sessions are for humans in a browser tab, not long-lived server
// credentials (that's what API keys are for). 8h covers a working session without
// leaving a stolen cookie useful for days.
const SESSION_TTL_SECONDS = 8 * 60 * 60;

const SESSION_KEY_PREFIX = "session:";

/** I6: crypto.randomBytes, never Math.random — this token is the entire session credential. */
function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** R13.2: mints a session bound to one account_id and stores it in Redis (ephemeral
 * state, TECHSTACK.md's rule — Postgres stays the record of truth). Returns the raw
 * token; the caller sets it as the `sid` cookie, never logs it. */
export async function createSession(redis: Redis, accountId: string): Promise<string> {
  const token = generateSessionToken();
  await redis.setex(`${SESSION_KEY_PREFIX}${token}`, SESSION_TTL_SECONDS, accountId);
  return token;
}

export async function destroySession(redis: Redis, token: string): Promise<void> {
  await redis.del(`${SESSION_KEY_PREFIX}${token}`);
}

/**
 * R13.2: httpOnly + SameSite=Lax so the cookie is invisible to page JS and never sent
 * cross-site — `secure` only in production because local dev over plain http can't set
 * a Secure cookie. Dashboard and API must be same-origin (see nginx/vite proxy) for
 * Lax to actually reach the API; ARCHITECTURE.md's no-BFF CORS setup this project
 * shipped with does not carry credentialed cookies cross-origin, deliberately.
 */
export function setSessionCookie(reply: FastifyReply, token: string, config: Config): void {
  reply.setCookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: config.nodeEnv === "production",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export function clearSessionCookie(reply: FastifyReply, config: Config): void {
  reply.clearCookie(SESSION_COOKIE_NAME, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: config.nodeEnv === "production",
  });
}

export type SessionAuth = ReturnType<typeof createSessionAuth>;

/**
 * R13.2: the dashboard's counterpart to `apiKeyAuth` — resolves to the same `Account`
 * shape, so every existing account-scoped query works unchanged regardless of which
 * hook authenticated the request. Deliberately a separate hook, not a fallback inside
 * `apiKeyAuth`: a session must never authenticate `/v1/verification/*` (a server-to-
 * server surface) and an API key must never authenticate `/v1/keys` (a dashboard-only
 * surface) — two hooks on two disjoint route sets is what makes that a property of the
 * routing table, not something a reviewer has to trust a shared function got right.
 */
export function createSessionAuth(pg: PgClient, redis: Redis) {
  return async function sessionAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = request.cookies[SESSION_COOKIE_NAME];
    if (!token) {
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }

    const accountId = await redis.get(`${SESSION_KEY_PREFIX}${token}`);
    if (!accountId) {
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }

    const account = await findAccountById(pg, accountId);
    if (!account || account.status !== "active") {
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }

    request.account = account;
  };
}
