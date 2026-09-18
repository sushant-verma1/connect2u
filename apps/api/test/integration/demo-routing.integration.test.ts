import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { ulid } from "ulid";
import { insertAccount } from "@otp-router/db/repositories/accounts";
import { activateRoutingPolicy } from "@otp-router/db/repositories/routing-policies";
import {
  insertDeliveryAttempt,
  markDeliveryAttemptSent,
} from "@otp-router/db/repositories/delivery-attempts";
import { insertVerification } from "@otp-router/db/repositories/verifications";
import { computeChannelStats } from "@otp-router/db/repositories/channel-scores";
import { DEMO_ACCOUNT_ID } from "@otp-router/core/demo";
import { buildApp } from "../../src/app.js";
import { hashPhone } from "../../src/crypto/phone.js";
import {
  seedAccount as seedAccountShared,
  startInfra,
  truncateAll,
  type Infra,
} from "./harness.js";

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
  trustProxy: "loopback,uniquelocal",
};

/** Mirrors apps/api/src/scripts/seed-demo.ts's shape, with a caller-chosen policy so
 * tests can prove I10 (the demo reads whatever policy is active, not a constant). */
async function seedDemoAccount(
  infra: Infra,
  timeoutsMs: { whatsapp: number; sms: number } = { whatsapp: 5000, sms: 5000 },
): Promise<void> {
  await insertAccount(infra.pg, {
    id: DEMO_ACCOUNT_ID,
    name: "Public demo",
    email: "demo@otp-router.invalid",
    passwordHash: null,
    googleSub: null,
    status: "active",
  });
  await activateRoutingPolicy(infra.pg, {
    id: `rtp_${ulid()}`,
    accountId: DEMO_ACCOUNT_ID,
    policyJson: {
      version: 1,
      rules: [],
      default: { channels: ["whatsapp", "sms"], timeouts_ms: timeoutsMs },
    },
  });
}

let infra: Infra;
let app: FastifyInstance;

beforeAll(async () => {
  infra = await startInfra();
  config.databaseUrl = infra.databaseUrl;
  config.redisUrl = infra.redisUrl;
}, 120_000);

afterAll(async () => {
  await infra?.stop();
});

async function buildTestApp(timeoutsMs?: {
  whatsapp: number;
  sms: number;
}): Promise<FastifyInstance> {
  await seedDemoAccount(infra, timeoutsMs);
  const bullConnection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  // registerDemoRoutes is conditional on the demo account existing at boot (app.ts) —
  // seedDemoAccount above must run before buildApp, not after. No delivery/webhook
  // workers are started here: /v1/demo/routing/* never enqueues a job (unlike the old
  // /v1/demo/* routes), so there is nothing for a worker to process.
  const builtApp = await buildApp(config, infra.pg, infra.redis, bullConnection);
  builtApp.addHook("onClose", async () => {
    bullConnection.disconnect();
  });
  return builtApp;
}

async function startSession(builtApp: FastifyInstance): Promise<string> {
  const res = await builtApp.inject({ method: "POST", url: "/v1/demo/routing/start", payload: {} });
  expect(res.statusCode).toBe(201);
  return res.json().session_id;
}

async function completeCalibration(builtApp: FastifyInstance, sessionId: string): Promise<void> {
  for (const channel of ["whatsapp", "whatsapp", "sms"]) {
    const res = await builtApp.inject({
      method: "POST",
      url: `/v1/demo/routing/${sessionId}/calibration`,
      payload: { channel },
    });
    expect(res.statusCode).toBe(200);
  }
}

async function beginAttempt(builtApp: FastifyInstance, sessionId: string) {
  const res = await builtApp.inject({
    method: "POST",
    url: `/v1/demo/routing/${sessionId}/attempt`,
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

async function verify(builtApp: FastifyInstance, sessionId: string, channel: string) {
  return builtApp.inject({
    method: "POST",
    url: `/v1/demo/routing/${sessionId}/verify`,
    payload: { channel },
  });
}

/** Runs all 10 adaptive attempts, always verifying through the priority channel the
 * router just chose -- the fast, no-fallback path most tests just need to get through
 * the whole session. */
async function runAllAdaptiveAttempts(builtApp: FastifyInstance, sessionId: string): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const { pending } = await beginAttempt(builtApp, sessionId);
    const res = await verify(builtApp, sessionId, pending.routed_channel);
    expect(res.statusCode).toBe(200);
  }
}

beforeEach(async () => {
  await truncateAll(infra.pg, infra.redis);
});

afterEach(async () => {
  await app?.close();
});

describe("public demo — /v1/demo/routing/*", () => {
  it("calibration attempts 1, 2, and 3 each accept a whatsapp/sms choice, then switch to adaptive", async () => {
    app = await buildTestApp();
    const sessionId = await startSession(app);

    const first = await app.inject({
      method: "POST",
      url: `/v1/demo/routing/${sessionId}/calibration`,
      payload: { channel: "whatsapp" },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      phase: "calibration",
      calibration: { completed: 1, total: 3 },
    });
    expect(first.json().attempt.routed_channel).toBe("whatsapp");

    const second = await app.inject({
      method: "POST",
      url: `/v1/demo/routing/${sessionId}/calibration`,
      payload: { channel: "sms" },
    });
    expect(second.json()).toMatchObject({
      phase: "calibration",
      calibration: { completed: 2, total: 3 },
    });

    const third = await app.inject({
      method: "POST",
      url: `/v1/demo/routing/${sessionId}/calibration`,
      payload: { channel: "sms" },
    });
    // Calibration attempt 3 completes calibration -- the phase switches automatically,
    // enforced server-side, not by the dashboard hiding the calibration buttons.
    expect(third.json()).toMatchObject({
      phase: "adaptive",
      calibration: { completed: 3, total: 3 },
    });
  });

  it("rejects an adaptive attempt before calibration is complete", async () => {
    app = await buildTestApp();
    const sessionId = await startSession(app);

    const res = await app.inject({ method: "POST", url: `/v1/demo/routing/${sessionId}/attempt` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("not_in_adaptive_phase");
  });

  it("adaptive attempts choose the channel automatically -- the begin call takes no channel at all", async () => {
    app = await buildTestApp();
    const sessionId = await startSession(app);
    await completeCalibration(app, sessionId);

    // The route declares no body schema for this endpoint at all -- there is no field
    // a client could supply to influence the routed channel.
    const res = await app.inject({
      method: "POST",
      url: `/v1/demo/routing/${sessionId}/attempt`,
      payload: { channel: "sms" },
    });
    expect(res.statusCode).toBe(200);
    const { pending } = res.json();
    expect(["whatsapp", "sms"]).toContain(pending.routed_channel);
    expect(pending.decision_log.length).toBeGreaterThan(0);
    expect(pending.timeout_ms).toBe(5000);

    // A calibration POST is rejected once the session has moved past calibration.
    const calibrationAfter = await app.inject({
      method: "POST",
      url: `/v1/demo/routing/${sessionId}/calibration`,
      payload: { channel: "whatsapp" },
    });
    expect(calibrationAfter.statusCode).toBe(409);
    expect(calibrationAfter.json().error).toBe("not_in_calibration_phase");
  });

  it("rejects beginning a second attempt while one is already pending", async () => {
    app = await buildTestApp();
    const sessionId = await startSession(app);
    await completeCalibration(app, sessionId);
    await beginAttempt(app, sessionId);

    const second = await app.inject({
      method: "POST",
      url: `/v1/demo/routing/${sessionId}/attempt`,
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("attempt_already_pending");
  });

  it("rejects verifying with no attempt pending", async () => {
    app = await buildTestApp();
    const sessionId = await startSession(app);
    await completeCalibration(app, sessionId);

    const res = await verify(app, sessionId, "whatsapp");
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("no_pending_attempt");
  });

  it("verifying the priority channel before the deadline records it verified, no fallback", async () => {
    app = await buildTestApp();
    const sessionId = await startSession(app);
    await completeCalibration(app, sessionId);
    const { pending } = await beginAttempt(app, sessionId);

    const res = await verify(app, sessionId, pending.routed_channel);
    expect(res.statusCode).toBe(200);
    const { attempt } = res.json();
    expect(attempt.final_channel).toBe(pending.routed_channel);
    expect(attempt.fallback_used).toBe(false);
    expect(attempt.primary.outcome).toBe("verified");
  });

  it("rejects verifying the fallback channel before the priority deadline, then accepts it once the deadline has passed", async () => {
    // A tiny real policy timeout (not the 5s demo default) so this test crosses the
    // deadline with a real short sleep instead of faking the clock -- faking global
    // timers here would also stall the Postgres/Redis testcontainers connections this
    // same request depends on.
    app = await buildTestApp({ whatsapp: 50, sms: 50 });
    const sessionId = await startSession(app);
    await completeCalibration(app, sessionId);
    const { pending } = await beginAttempt(app, sessionId);
    expect(pending.timeout_ms).toBe(50);
    const fallbackChannel = pending.fallback_channel;

    const tooEarly = await verify(app, sessionId, fallbackChannel);
    expect(tooEarly.statusCode).toBe(409);
    expect(tooEarly.json().error).toBe("channel_not_available");

    await new Promise((resolve) => setTimeout(resolve, 75));

    // The priority channel is no longer available once the deadline has passed.
    const stalePriority = await verify(app, sessionId, pending.routed_channel);
    expect(stalePriority.statusCode).toBe(409);

    const res = await verify(app, sessionId, fallbackChannel);
    expect(res.statusCode).toBe(200);
    const { attempt } = res.json();
    expect(attempt.fallback_used).toBe(true);
    expect(attempt.primary.outcome).toBe("timeout");
    expect(attempt.primary.latency_ms).toBe(50);
    expect(attempt.fallback.channel).toBe(fallbackChannel);
    expect(attempt.fallback.outcome).toBe("verified");
    expect(attempt.final_channel).toBe(fallbackChannel);
  });

  it("uses exactly a 5s window for the demo account's own seeded policy", async () => {
    app = await buildTestApp(); // seed-demo.ts's own policy shape: 5s/5s
    const sessionId = await startSession(app);
    await completeCalibration(app, sessionId);
    const { pending } = await beginAttempt(app, sessionId);
    expect(pending.timeout_ms).toBe(5000);
    expect(pending.priority_deadline_ms - pending.started_at_ms).toBe(5000);
  });

  it("reads the fallback deadline from whatever policy is active (I10), not a hardcoded value", async () => {
    app = await buildTestApp({ whatsapp: 1234, sms: 1234 });
    const sessionId = await startSession(app);
    await completeCalibration(app, sessionId);
    const { pending } = await beginAttempt(app, sessionId);
    expect(pending.timeout_ms).toBe(1234);
    expect(pending.priority_deadline_ms - pending.started_at_ms).toBe(1234);
  });

  it("a fallback verification changes the next attempt's routing decision", async () => {
    app = await buildTestApp({ whatsapp: 20, sms: 20 }); // tiny window, real sleep below
    const sessionId = await startSession(app);
    // whatsapp x2, sms x1 -> whatsapp leads into adaptive #1.
    await completeCalibration(app, sessionId);
    const { pending: first } = await beginAttempt(app, sessionId);
    expect(first.routed_channel).toBe("whatsapp");

    await new Promise((resolve) => setTimeout(resolve, 30));
    await verify(app, sessionId, first.fallback_channel); // sms verified via fallback

    // wa 2/4, sms 2/4 -- tied, and sms was the channel most recently verified.
    const { pending: second } = await beginAttempt(app, sessionId);
    expect(second.routed_channel).toBe("sms");
    expect(second.reason).toContain("recently verified channel");
  });

  it("allows exactly 10 adaptive attempts and rejects an 11th", async () => {
    app = await buildTestApp();
    const sessionId = await startSession(app);
    await completeCalibration(app, sessionId);
    await runAllAdaptiveAttempts(app, sessionId);

    const eleventh = await app.inject({
      method: "POST",
      url: `/v1/demo/routing/${sessionId}/attempt`,
    });
    expect(eleventh.statusCode).toBe(409);
    expect(eleventh.json().error).toBe("not_in_adaptive_phase");
  });

  it("rejects further attempts once a session is complete, and serves the report", async () => {
    app = await buildTestApp();
    const sessionId = await startSession(app);
    await completeCalibration(app, sessionId);

    // Not ready before adaptive attempts finish.
    const early = await app.inject({ method: "GET", url: `/v1/demo/routing/${sessionId}/report` });
    expect(early.statusCode).toBe(409);
    expect(early.json().error).toBe("session_not_complete");

    await runAllAdaptiveAttempts(app, sessionId);

    const calibrationAfterComplete = await app.inject({
      method: "POST",
      url: `/v1/demo/routing/${sessionId}/calibration`,
      payload: { channel: "whatsapp" },
    });
    expect(calibrationAfterComplete.statusCode).toBe(409);

    const report = await app.inject({ method: "GET", url: `/v1/demo/routing/${sessionId}/report` });
    expect(report.statusCode).toBe(200);
    const body = report.json();
    // The report is built only from the 10 adaptive attempts -- calibration's 3 never
    // appear in the totals.
    expect(body.adaptive).toHaveLength(10);
    expect(body.calibration).toHaveLength(3);
    expect(body.channel_usage.whatsapp + body.channel_usage.sms).toBe(10);
    expect(["whatsapp", "sms"]).toContain(body.final_channel);
    expect(typeof body.routing_changes).toBe("number");
    expect(typeof body.fallback_events).toBe("number");
    expect(typeof body.explanation).toBe("string");
  });

  it("rejects an unknown or foreign session id with 404, never another session's state", async () => {
    app = await buildTestApp();
    const sessionId = await startSession(app);

    const bogus = await app.inject({ method: "GET", url: "/v1/demo/routing/not-a-real-session" });
    expect(bogus.statusCode).toBe(404);

    const bogusAttempt = await app.inject({
      method: "POST",
      url: "/v1/demo/routing/not-a-real-session/attempt",
    });
    expect(bogusAttempt.statusCode).toBe(404);

    // The real session, looked up by its own id, is unaffected by probing a bogus one.
    const real = await app.inject({ method: "GET", url: `/v1/demo/routing/${sessionId}` });
    expect(real.statusCode).toBe(200);
  });

  it("GET returns the full attempt history for polling clients", async () => {
    app = await buildTestApp();
    const sessionId = await startSession(app);
    await completeCalibration(app, sessionId);

    const state = await app.inject({ method: "GET", url: `/v1/demo/routing/${sessionId}` });
    expect(state.statusCode).toBe(200);
    expect(state.json().attempts).toHaveLength(3);
    expect(state.json().phase).toBe("adaptive");
  });

  it("returns 429 with Retry-After once the per-IP start limit is exceeded", async () => {
    app = await buildTestApp();
    let last;
    for (let i = 0; i < 6; i++) {
      last = await app.inject({ method: "POST", url: "/v1/demo/routing/start", payload: {} });
    }
    expect(last?.statusCode).toBe(429);
    expect(last?.json().error).toBe("rate_limited_ip");
    expect(last?.headers["retry-after"]).toBeDefined();
  });

  it("never writes a verification, delivery attempt, or channel score row for a full 13-attempt run", async () => {
    app = await buildTestApp();
    const sessionId = await startSession(app);
    await completeCalibration(app, sessionId);
    await runAllAdaptiveAttempts(app, sessionId);
    await app.inject({ method: "GET", url: `/v1/demo/routing/${sessionId}/report` });

    const [verificationRow] = await infra.pg<
      { count: string }[]
    >`SELECT COUNT(*) FROM verifications`;
    const [attemptRow] = await infra.pg<
      { count: string }[]
    >`SELECT COUNT(*) FROM delivery_attempts`;
    const [scoreRow] = await infra.pg<{ count: string }[]>`SELECT COUNT(*) FROM channel_scores`;
    const [decisionRow] = await infra.pg<
      { count: string }[]
    >`SELECT COUNT(*) FROM routing_decisions`;
    expect(Number(verificationRow?.count)).toBe(0);
    expect(Number(attemptRow?.count)).toBe(0);
    expect(Number(scoreRow?.count)).toBe(0);
    expect(Number(decisionRow?.count)).toBe(0);
  });

  it("(defence in depth) computeChannelStats still excludes DEMO_ACCOUNT_ID even if a delivery_attempts row for it ever existed", async () => {
    app = await buildTestApp();
    const windowStart = new Date(Date.now() - 60_000);

    const demoVerificationId = `ver_${ulid()}`;
    await insertVerification(infra.pg, {
      id: demoVerificationId,
      accountId: DEMO_ACCOUNT_ID,
      phoneHash: hashPhone("+61491570006", PHONE_HASH_PEPPER),
      phoneEncrypted: "enc",
      codeHmac: "hmac",
      codeEncrypted: "enc",
      channelChain: ["whatsapp"],
      channelTimeoutsMs: { whatsapp: 5000 },
      expiresAt: new Date(Date.now() + 60_000),
      metadataJson: {},
      idempotencyKey: null,
    });
    const demoAttempt = await insertDeliveryAttempt(infra.pg, {
      id: `att_${ulid()}`,
      verificationId: demoVerificationId,
      accountId: DEMO_ACCOUNT_ID,
      channel: "whatsapp",
      provider: "simulated",
      status: "queued",
    });
    await markDeliveryAttemptSent(infra.pg, {
      id: demoAttempt.id,
      providerMessageId: `sim_${ulid()}`,
      country: "INTL",
    });

    const { accountId: realAccountId } = await seedAccountShared(infra.pg, API_KEY_PEPPER, "Real");
    const realVerificationId = `ver_${ulid()}`;
    await insertVerification(infra.pg, {
      id: realVerificationId,
      accountId: realAccountId,
      phoneHash: hashPhone("+919876543210", PHONE_HASH_PEPPER),
      phoneEncrypted: "enc",
      codeHmac: "hmac",
      codeEncrypted: "enc",
      channelChain: ["whatsapp"],
      channelTimeoutsMs: { whatsapp: 20_000 },
      expiresAt: new Date(Date.now() + 60_000),
      metadataJson: {},
      idempotencyKey: null,
    });
    const realAttempt = await insertDeliveryAttempt(infra.pg, {
      id: `att_${ulid()}`,
      verificationId: realVerificationId,
      accountId: realAccountId,
      channel: "whatsapp",
      provider: "simulated",
      status: "queued",
    });
    await markDeliveryAttemptSent(infra.pg, {
      id: realAttempt.id,
      providerMessageId: `sim_${ulid()}`,
      country: "IN",
    });

    const stats = await computeChannelStats(infra.pg, windowStart, new Date());
    const intlRow = stats.find((s) => s.channel === "whatsapp" && s.country === "INTL");
    const inRow = stats.find((s) => s.channel === "whatsapp" && s.country === "IN");
    expect(intlRow).toBeUndefined();
    expect(inRow?.sends).toBe(1);
  });
});
