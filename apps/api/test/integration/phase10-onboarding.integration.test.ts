import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { registerGoogleAuthRoutes } from "../../src/routes/auth-google.js";
import type { GoogleUserinfo } from "../../src/services/google-oauth.js";
import { seedAccount, startInfra, truncateAll, type Infra } from "./harness.js";

const OTP_PEPPER = "test-otp-pepper";
const PHONE_HASH_PEPPER = "test-phone-hash-pepper";
const API_KEY_PEPPER = "test-api-key-pepper";
const PASSWORD_PEPPER = "test-password-pepper";
const PHONE_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
const CODE_ENCRYPTION_KEY = Buffer.alloc(32, 10).toString("base64");

const config = {
  nodeEnv: "test" as const,
  port: 0,
  logLevel: "silent" as const,
  databaseUrl: "",
  redisUrl: "",
  otpPepper: OTP_PEPPER,
  phoneHashPepper: PHONE_HASH_PEPPER,
  apiKeyPepper: API_KEY_PEPPER,
  passwordPepper: PASSWORD_PEPPER,
  phoneEncryptionKey: PHONE_ENCRYPTION_KEY,
  codeEncryptionKey: CODE_ENCRYPTION_KEY,
  dashboardOrigin: "http://localhost:5173",
};

let infra: Infra;
let app: FastifyInstance;

/** A response can carry more than one `Set-Cookie` header (the Google callback clears
 * `oauth_tx` and sets `sid` in the same response) — light-my-request surfaces that as
 * an array, so every lookup here searches all of them, not just the first. */
function cookieValueFrom(
  setCookieHeader: string | string[] | undefined,
  name: string,
): string | undefined {
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader ?? ""];
  for (const header of headers) {
    const match = new RegExp(`${name}=([^;]+)`).exec(header);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function sessionCookieFrom(setCookieHeader: string | string[] | undefined): string {
  const value = cookieValueFrom(setCookieHeader, "sid");
  if (!value) throw new Error(`no sid cookie in: ${JSON.stringify(setCookieHeader)}`);
  return `sid=${value}`;
}

/** GET /v1/auth/google isn't gated behind buildApp's config check in these tests —
 * `registerGoogleAuthRoutes` is called directly per test with a fake `exchangeCode`
 * (per the report: no HTTP-mocking dependency, the real exchange is just a default
 * parameter). Returns the `oauth_tx` cookie and the `state` Google would echo back. */
async function beginGoogleFlow(app: FastifyInstance): Promise<{ cookie: string; state: string }> {
  const res = await app.inject({ method: "GET", url: "/v1/auth/google" });
  expect(res.statusCode).toBe(302);
  const locationHeader = res.headers.location;
  if (typeof locationHeader !== "string") throw new Error("expected a Location header");
  const location = new URL(locationHeader);
  const state = location.searchParams.get("state");
  if (!state) throw new Error("no state in redirect Location");
  const oauthTx = cookieValueFrom(res.headers["set-cookie"], "oauth_tx");
  if (!oauthTx) throw new Error("no oauth_tx cookie in redirect response");
  return { cookie: `oauth_tx=${oauthTx}`, state };
}

beforeAll(async () => {
  infra = await startInfra();
  config.databaseUrl = infra.databaseUrl;
  config.redisUrl = infra.redisUrl;
}, 120_000);

afterAll(async () => {
  await infra?.stop();
});

beforeEach(async () => {
  await truncateAll(infra.pg, infra.redis);
  app = await buildApp(config, infra.pg, infra.redis, infra.redis);
});

afterEach(async () => {
  await app.close();
});

describe("R13.1/R13.2 — signup and sessions", () => {
  it("signup creates exactly one account and exactly one key, and returns the key once", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/signup",
      payload: { email: "founder@example.com", password: "correct horse battery staple" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.api_key).toMatch(/^sk_test_/);

    const accountRows = await infra.pg`SELECT count(*)::int AS count FROM accounts`;
    const keyRows = await infra.pg`SELECT count(*)::int AS count FROM api_keys`;
    expect(accountRows[0]?.count).toBe(1);
    expect(keyRows[0]?.count).toBe(1);

    const cookie = sessionCookieFrom(res.headers["set-cookie"]);
    const listRes = await app.inject({
      method: "GET",
      url: "/v1/keys",
      headers: { cookie },
    });
    expect(listRes.statusCode).toBe(200);
    const { keys } = listRes.json();
    expect(keys).toHaveLength(1);
    expect(keys[0].prefix).toMatch(/^sk_test_/);
    expect(keys[0]).not.toHaveProperty("api_key");
    expect(JSON.stringify(listRes.json())).not.toContain(body.api_key.split(".")[1]);
  });

  it("GET /v1/auth/me reflects the session, and 401s once logged out", async () => {
    const signup = await app.inject({
      method: "POST",
      url: "/v1/auth/signup",
      payload: { email: "me@example.com", password: "correct horse battery staple" },
    });
    const cookie = sessionCookieFrom(signup.headers["set-cookie"]);

    const me = await app.inject({ method: "GET", url: "/v1/auth/me", headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().email).toBe("me@example.com");

    await app.inject({ method: "POST", url: "/v1/auth/logout", headers: { cookie } });
    const afterLogout = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { cookie },
    });
    expect(afterLogout.statusCode).toBe(401);
  });

  it("a session cannot call a verification endpoint (R13.2's disjoint-auth rule)", async () => {
    const signup = await app.inject({
      method: "POST",
      url: "/v1/auth/signup",
      payload: { email: "session-only@example.com", password: "correct horse battery staple" },
    });
    const cookie = sessionCookieFrom(signup.headers["set-cookie"]);

    const res = await app.inject({
      method: "POST",
      url: "/v1/verification/start",
      headers: { cookie },
      payload: { phone_number: "+919876543210" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("an API key cannot call /v1/keys (R13.2's disjoint-auth rule)", async () => {
    const { apiKey } = await seedAccount(infra.pg, API_KEY_PEPPER, "Acme");

    const res = await app.inject({
      method: "GET",
      url: "/v1/keys",
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("logout clears the session — the same cookie is rejected afterwards", async () => {
    const signup = await app.inject({
      method: "POST",
      url: "/v1/auth/signup",
      payload: { email: "logout@example.com", password: "correct horse battery staple" },
    });
    const cookie = sessionCookieFrom(signup.headers["set-cookie"]);

    const logout = await app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: { cookie },
    });
    expect(logout.statusCode).toBe(200);

    const afterLogout = await app.inject({ method: "GET", url: "/v1/keys", headers: { cookie } });
    expect(afterLogout.statusCode).toBe(401);
  });

  it("login with the wrong password is rejected without creating a session", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/auth/signup",
      payload: { email: "wrongpass@example.com", password: "correct horse battery staple" },
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "wrongpass@example.com", password: "not the right password" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });
});

describe("R13.3/R13.5 — key lifecycle", () => {
  it("a revoked key is rejected within the cache window's stated bound (immediately, on this instance)", async () => {
    const signup = await app.inject({
      method: "POST",
      url: "/v1/auth/signup",
      payload: { email: "revoke@example.com", password: "correct horse battery staple" },
    });
    const cookie = sessionCookieFrom(signup.headers["set-cookie"]);
    const apiKey: string = signup.json().api_key;

    // Prime the auth cache the same way a real client would, before revoking.
    const primed = await app.inject({
      method: "GET",
      url: "/v1/verification/ver_nonexistent",
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(primed.statusCode).toBe(404); // authenticated, just no such verification

    const listRes = await app.inject({ method: "GET", url: "/v1/keys", headers: { cookie } });
    const keyId: string = listRes.json().keys[0].id;

    const revokeRes = await app.inject({
      method: "DELETE",
      url: `/v1/keys/${keyId}`,
      headers: { cookie },
    });
    expect(revokeRes.statusCode).toBe(200);
    expect(revokeRes.json()).toEqual({ revoked: true, cache_ttl_seconds: 30 });

    // I2/R13.5: invalidateKey drops this instance's cache entry synchronously — no
    // sleep, no 30s wait. If this ever starts failing, the cache bypass regressed.
    const afterRevoke = await app.inject({
      method: "GET",
      url: "/v1/verification/ver_nonexistent",
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(afterRevoke.statusCode).toBe(401);
  });

  it("GET /v1/keys never returns a revoked key", async () => {
    const signup = await app.inject({
      method: "POST",
      url: "/v1/auth/signup",
      payload: { email: "listrevoked@example.com", password: "correct horse battery staple" },
    });
    const cookie = sessionCookieFrom(signup.headers["set-cookie"]);
    const firstKeyId: string = (
      await app.inject({ method: "GET", url: "/v1/keys", headers: { cookie } })
    ).json().keys[0].id;

    await app.inject({ method: "DELETE", url: `/v1/keys/${firstKeyId}`, headers: { cookie } });
    await app.inject({ method: "POST", url: "/v1/keys", headers: { cookie } });

    const res = await app.inject({ method: "GET", url: "/v1/keys", headers: { cookie } });
    const { keys } = res.json();
    expect(keys).toHaveLength(1);
    expect(keys[0].id).not.toBe(firstKeyId);
  });

  it("revoking someone else's key id returns 404, not another account's key", async () => {
    const signupA = await app.inject({
      method: "POST",
      url: "/v1/auth/signup",
      payload: { email: "owner-a@example.com", password: "correct horse battery staple" },
    });
    const signupB = await app.inject({
      method: "POST",
      url: "/v1/auth/signup",
      payload: { email: "owner-b@example.com", password: "correct horse battery staple" },
    });
    const cookieA = sessionCookieFrom(signupA.headers["set-cookie"]);
    const cookieB = sessionCookieFrom(signupB.headers["set-cookie"]);

    const keyIdB: string = (
      await app.inject({ method: "GET", url: "/v1/keys", headers: { cookie: cookieB } })
    ).json().keys[0].id;

    const res = await app.inject({
      method: "DELETE",
      url: `/v1/keys/${keyIdB}`,
      headers: { cookie: cookieA },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("R13.6 — credential-stuffing rate limits", () => {
  it("6th login attempt for the same email within the window is rate limited", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/auth/signup",
      payload: { email: "stuffed@example.com", password: "correct horse battery staple" },
    });

    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { email: "stuffed@example.com", password: "wrong password" },
      });
      expect(res.statusCode).toBe(401);
    }

    const sixth = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "stuffed@example.com", password: "wrong password" },
    });
    expect(sixth.statusCode).toBe(429);
    expect(sixth.headers["retry-after"]).toBeDefined();
  });
});

describe("R13.7 — Google sign-in", () => {
  const fakeUserinfo: GoogleUserinfo = {
    sub: "google-sub-123",
    email: "googler@example.com",
    emailVerified: true,
    name: "Googler",
  };

  function registerFakeGoogle(userinfo: GoogleUserinfo = fakeUserinfo): void {
    registerGoogleAuthRoutes(
      app,
      infra.pg,
      infra.redis,
      config,
      "test-client-id",
      "test-client-secret",
      async () => userinfo,
    );
  }

  it("the callback rejects a mismatched state", async () => {
    registerFakeGoogle();
    const { cookie } = await beginGoogleFlow(app);

    const res = await app.inject({
      method: "GET",
      url: "/v1/auth/google/callback?code=fake-code&state=not-the-real-state",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
    expect(cookieValueFrom(res.headers["set-cookie"], "sid")).toBeUndefined();

    const rows = await infra.pg`SELECT count(*)::int AS count FROM accounts`;
    expect(rows[0]?.count).toBe(0);
  });

  it("a Google signup creates an account with a null password_hash and a set google_sub", async () => {
    registerFakeGoogle();
    const { cookie, state } = await beginGoogleFlow(app);

    const res = await app.inject({
      method: "GET",
      url: `/v1/auth/google/callback?code=fake-code&state=${state}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(302);
    expect(sessionCookieFrom(res.headers["set-cookie"])).toMatch(/^sid=/);

    const rows = await infra.pg`SELECT password_hash, google_sub, email FROM accounts`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.password_hash).toBeNull();
    expect(rows[0]?.google_sub).toBe(fakeUserinfo.sub);
    expect(rows[0]?.email).toBe(fakeUserinfo.email);
  });

  it("D1: Google sign-in on an email that already has a password is rejected, not linked", async () => {
    registerFakeGoogle();

    const signupRes = await app.inject({
      method: "POST",
      url: "/v1/auth/signup",
      payload: { email: fakeUserinfo.email, password: "correct horse battery staple" },
    });
    expect(signupRes.statusCode).toBe(201);

    const { cookie, state } = await beginGoogleFlow(app);

    const res = await app.inject({
      method: "GET",
      url: `/v1/auth/google/callback?code=fake-code&state=${state}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(409);
    expect(cookieValueFrom(res.headers["set-cookie"], "sid")).toBeUndefined();

    // The existing row is untouched — still password-only, never linked to the sub.
    const rows =
      await infra.pg`SELECT password_hash, google_sub FROM accounts WHERE email = ${fakeUserinfo.email}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.password_hash).not.toBeNull();
    expect(rows[0]?.google_sub).toBeNull();
  });

  it("a returning Google user (same sub) reuses the same account, not a duplicate", async () => {
    registerFakeGoogle();

    const first = await beginGoogleFlow(app);
    await app.inject({
      method: "GET",
      url: `/v1/auth/google/callback?code=fake-code&state=${first.state}`,
      headers: { cookie: first.cookie },
    });

    const second = await beginGoogleFlow(app);
    const secondRes = await app.inject({
      method: "GET",
      url: `/v1/auth/google/callback?code=fake-code&state=${second.state}`,
      headers: { cookie: second.cookie },
    });
    expect(secondRes.statusCode).toBe(302);

    const rows = await infra.pg`SELECT count(*)::int AS count FROM accounts`;
    expect(rows[0]?.count).toBe(1);
  });
});
