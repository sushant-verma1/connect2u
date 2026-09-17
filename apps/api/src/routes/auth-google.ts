import type { FastifyInstance } from "fastify";
import { ulid } from "ulid";
import { z } from "zod";
import type { PgClient } from "@otp-router/db/client";
import {
  findAccountByEmail,
  findAccountByGoogleSub,
  insertAccount,
} from "@otp-router/db/repositories/accounts";
import type { Redis } from "ioredis";
import {
  buildGoogleAuthorizationUrl,
  exchangeGoogleCode,
  generatePkcePair,
  generateState,
  type GoogleTokenExchange,
} from "../services/google-oauth.js";
import { createSession, setSessionCookie } from "../auth/session.js";
import type { Config } from "../config.js";

const OAUTH_TX_COOKIE = "oauth_tx";
const OAUTH_TX_TTL_SECONDS = 10 * 60;
const OAUTH_TX_PATH = "/v1/auth/google";

const callbackQuerySchema = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
});

/**
 * R13.7: registered only once both Google credentials exist — same conditional shape
 * as app.ts's Meta registration, so a Google-less local dev environment still boots.
 * `exchangeCode` is injectable so the integration suite can drive the callback without
 * a live Google account or an HTTP-mocking dependency (default is the real exchange).
 */
export function registerGoogleAuthRoutes(
  app: FastifyInstance,
  pg: PgClient,
  redis: Redis,
  config: Config,
  clientId: string,
  clientSecret: string,
  exchangeCode: GoogleTokenExchange = exchangeGoogleCode,
): void {
  const redirectUri = `${config.dashboardOrigin}/v1/auth/google/callback`;

  app.get("/v1/auth/google", { schema: { hide: true } }, async (request, reply) => {
    const { codeVerifier, codeChallenge } = generatePkcePair();
    const state = generateState();

    reply.setCookie(OAUTH_TX_COOKIE, `${state}.${codeVerifier}`, {
      httpOnly: true,
      sameSite: "lax",
      path: OAUTH_TX_PATH,
      secure: config.nodeEnv === "production",
      maxAge: OAUTH_TX_TTL_SECONDS,
    });

    const authorizationUrl = buildGoogleAuthorizationUrl({
      clientId,
      redirectUri,
      state,
      codeChallenge,
    });
    return reply.redirect(authorizationUrl, 302);
  });

  app.get<{ Querystring: z.infer<typeof callbackQuerySchema> }>(
    "/v1/auth/google/callback",
    { schema: { hide: true } },
    async (request, reply) => {
      const query = callbackQuerySchema.parse(request.query);
      const tx = request.cookies[OAUTH_TX_COOKIE];
      reply.clearCookie(OAUTH_TX_COOKIE, { path: OAUTH_TX_PATH });

      // R13.7: the state check is the CSRF defense on this callback — a request
      // without a matching `oauth_tx` cookie never reaches the token exchange,
      // regardless of whether `code` looks valid.
      //
      // The clearCookie above is a browser-side instruction only: nothing records the
      // state/verifier pair server-side, so a captured `oauth_tx` value replayed with
      // its matching `code` would still pass this check. What actually prevents replay
      // is PKCE plus Google's single-use authorization code — the second exchange of
      // the same `code` fails at Google, whatever this cookie says.
      const [savedState, codeVerifier] = tx?.split(".") ?? [];
      if (
        !query.code ||
        !query.state ||
        !savedState ||
        !codeVerifier ||
        query.state !== savedState
      ) {
        // F2 (auth-audit): a redirect, same reasoning as the email conflict below —
        // this branch is reached by a top-level navigation, and its most common cause
        // is mundane rather than hostile: an `oauth_tx` cookie that aged out of its
        // 10-minute TTL while the consent screen sat open. Rejecting is still correct
        // (nothing reaches the token exchange); dead-ending in raw JSON was not.
        return reply.redirect(`${config.dashboardOrigin}/login?error=invalid_state`, 302);
      }

      const userinfo = await exchangeCode({
        code: query.code,
        codeVerifier,
        redirectUri,
        clientId,
        clientSecret,
      });
      const email = userinfo.email.toLowerCase();

      const linkedAccount = await findAccountByGoogleSub(pg, userinfo.sub);
      if (linkedAccount) {
        const token = await createSession(redis, linkedAccount.id);
        setSessionCookie(reply, token, config);
        return reply.redirect(config.dashboardOrigin, 302);
      }

      // D1 (report): never auto-link on a matching email, even when Google reports
      // `email_verified: true` — that flag attests Google controls the mailbox, not
      // that whoever registered this email here is the same person. An attacker who
      // pre-registers a victim's email with a password would otherwise take over the
      // account the first time the victim signs in with Google.
      //
      // F2 (auth-audit): a redirect, not a 409 body — this handler is reached by a
      // top-level browser navigation, so a JSON body renders as a bare page with no way
      // back. The reason travels as a query param the login page maps to a message
      // (LoginPage.tsx); it names no account and confirms nothing a caller didn't
      // already supply, same as signup's 409.
      const existingByEmail = await findAccountByEmail(pg, email);
      if (existingByEmail) {
        return reply.redirect(
          `${config.dashboardOrigin}/login?error=email_already_registered`,
          302,
        );
      }

      const account = await insertAccount(pg, {
        id: `acct_${ulid()}`,
        name: userinfo.name ?? email,
        email,
        googleSub: userinfo.sub,
        status: "active",
      });

      const token = await createSession(redis, account.id);
      setSessionCookie(reply, token, config);
      return reply.redirect(config.dashboardOrigin, 302);
    },
  );
}
