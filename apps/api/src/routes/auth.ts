import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Redis } from "ioredis";
import { ulid } from "ulid";
import { z } from "zod";
import type { PgClient } from "@otp-router/db/client";
import { findAccountByEmail, insertAccount } from "@otp-router/db/repositories/accounts";
import { insertApiKey } from "@otp-router/db/repositories/api-keys";
import { generateApiKey, hashApiKey } from "../crypto/api-key.js";
import { hashPassword, verifyPassword } from "../crypto/password.js";
import { checkLoginRateLimits, checkSlidingWindow } from "../services/rate-limit.js";
import {
  createSession,
  destroySession,
  setSessionCookie,
  clearSessionCookie,
  SESSION_COOKIE_NAME,
  type SessionAuth,
} from "../auth/session.js";
import type { Config } from "../config.js";

const errorResponseSchema = z.object({ error: z.string() });

const credentialsBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
});

const accountResponseSchema = z.object({
  account_id: z.string(),
  email: z.string(),
});

const signupResponseSchema = accountResponseSchema.extend({
  api_key: z.string(),
});

// D1 (report): never auto-link on email — a matching row is always a conflict,
// regardless of which side (password vs Google) got there first. Same message either
// way; it doesn't tell the caller which path the existing account used.
const EMAIL_CONFLICT = { error: "email_already_registered" } as const;

/** R13.6: constant-time-ish against email enumeration — a login for an email that
 * doesn't exist (or has no password, i.e. Google-only) still pays for one argon2
 * verify against a fixed hash, so "no such account" and "wrong password" take the same
 * shape of time. Computed once per process, not per request. */
let dummyHashPromise: Promise<string> | undefined;
function getDummyHash(pepper: string): Promise<string> {
  dummyHashPromise ??= hashPassword("dummy-password-for-timing-only", pepper);
  return dummyHashPromise;
}

function emailRateLimitKey(email: string): string {
  // Not a pepper — this isn't hiding the email from anyone who already has it (the
  // caller supplied it), just keeping raw user input out of a Redis key name.
  return createHash("sha256").update(email.toLowerCase()).digest("hex");
}

export function registerAuthRoutes(
  app: FastifyInstance,
  pg: PgClient,
  redis: Redis,
  config: Config,
  sessionAuth: SessionAuth,
): void {
  const server = app.withTypeProvider<ZodTypeProvider>();

  // R13.6: 5/hour per IP — signup isn't the credential-stuffing surface login is, but
  // an unbounded account-creation endpoint is its own abuse shape (mass signup).
  server.post(
    "/v1/auth/signup",
    {
      schema: {
        body: credentialsBodySchema,
        response: { 201: signupResponseSchema, 409: errorResponseSchema, 429: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const signupLimit = await checkSlidingWindow(
        redis,
        `rl:signup-ip:${request.ip}`,
        5,
        60 * 60 * 1000,
      );
      if (!signupLimit.allowed) {
        reply.header(
          "Retry-After",
          String(Math.max(1, Math.ceil(signupLimit.retryAfterMs / 1000))),
        );
        return reply.code(429).send({ error: "rate_limited_ip" });
      }

      const email = request.body.email.toLowerCase();
      const existing = await findAccountByEmail(pg, email);
      if (existing) {
        return reply.code(409).send(EMAIL_CONFLICT);
      }

      const passwordHash = await hashPassword(request.body.password, config.passwordPepper);
      const account = await insertAccount(pg, {
        id: `acct_${ulid()}`,
        name: email,
        email,
        passwordHash,
        status: "active",
      });

      const { fullKey, prefix } = generateApiKey("test");
      const keyHash = await hashApiKey(fullKey, config.apiKeyPepper);
      await insertApiKey(pg, {
        id: `key_${ulid()}`,
        accountId: account.id,
        keyHash,
        keyPrefix: prefix,
      });

      // Signing straight into a session too — self-serve onboarding means landing in
      // the dashboard already authenticated, not signing up and then having to log in.
      const token = await createSession(redis, account.id);
      setSessionCookie(reply, token, config);

      return reply
        .code(201)
        .send({ account_id: account.id, email: account.email, api_key: fullKey });
    },
  );

  server.post(
    "/v1/auth/login",
    {
      schema: {
        body: credentialsBodySchema,
        response: {
          200: accountResponseSchema,
          401: errorResponseSchema,
          429: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const email = request.body.email.toLowerCase();

      const breach = await checkLoginRateLimits(redis, {
        emailHash: emailRateLimitKey(email),
        ip: request.ip,
      });
      if (breach) {
        reply.header("Retry-After", String(Math.max(1, Math.ceil(breach.retryAfterMs / 1000))));
        return reply.code(429).send({ error: `rate_limited_${breach.scope}` });
      }

      const account = await findAccountByEmail(pg, email);
      const storedHash = account?.passwordHash ?? (await getDummyHash(config.passwordPepper));
      const valid = await verifyPassword(request.body.password, config.passwordPepper, storedHash);

      if (!account || !account.passwordHash || !valid || account.status !== "active") {
        return reply.code(401).send({ error: "invalid_credentials" });
      }

      const token = await createSession(redis, account.id);
      setSessionCookie(reply, token, config);
      return reply.code(200).send({ account_id: account.id, email: account.email });
    },
  );

  server.post(
    "/v1/auth/logout",
    { schema: { response: { 200: z.object({ ok: z.literal(true) }) } } },
    async (request, reply) => {
      const token = request.cookies[SESSION_COOKIE_NAME];
      if (token) {
        await destroySession(redis, token);
      }
      clearSessionCookie(reply, config);
      return reply.code(200).send({ ok: true });
    },
  );

  // The dashboard's bootstrap check — "is there a valid session" without piggybacking
  // on a data-bearing route like /v1/keys to find out.
  server.get(
    "/v1/auth/me",
    {
      preHandler: sessionAuth,
      schema: { response: { 200: accountResponseSchema, 401: errorResponseSchema } },
    },
    async (request, reply) => {
      return reply.code(200).send({ account_id: request.account.id, email: request.account.email });
    },
  );
}
