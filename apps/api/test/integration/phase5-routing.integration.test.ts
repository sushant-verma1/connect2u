import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { insertProviderRate } from "@otp-router/db/repositories/provider-rates";
import { upsertCapability } from "@otp-router/db/repositories/channel-capability";
import { closeQueues, createQueues, type Queues } from "@otp-router/worker/queue/queues";
import { buildApp } from "../../src/app.js";
import { hashPhone } from "../../src/crypto/phone.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Finds a `{ action: "skipped", channel, reason }` entry in a `decision_log_json`
 * value read back from Postgres — narrowed field by field instead of asserted. */
function findSkipReason(decisionLog: unknown, channel: string): string | undefined {
  if (!Array.isArray(decisionLog)) return undefined;
  for (const entry of decisionLog) {
    if (
      isRecord(entry) &&
      entry.action === "skipped" &&
      entry.channel === channel &&
      typeof entry.reason === "string"
    ) {
      return entry.reason;
    }
  }
  return undefined;
}
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

let infra: Infra;
let bullConnection: Redis;
let app: FastifyInstance;
let queues: Queues;
let apiKey: string;

async function seedAccount(name: string): Promise<{ accountId: string; apiKey: string }> {
  return seedAccountShared(infra.pg, API_KEY_PEPPER, name);
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
  ({ apiKey } = await seedAccount("Acme"));
  bullConnection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  queues = createQueues(bullConnection);
  app = await buildApp(config, infra.pg, infra.redis, bullConnection);
});

afterEach(async () => {
  await app.close();
  await closeQueues(queues);
  bullConnection.disconnect();
});

describe("Phase 5 — routing policy", () => {
  it("GET returns the default policy when the account has never set one", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/accounts/me/routing-policy",
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().policy.default.channels).toEqual(["whatsapp", "sms"]);
  });

  // Exit gate: changing the policy via API visibly changes the attempted channel, with
  // no deploy — same running `app` instance throughout, no restart of anything.
  it("PUT a new policy immediately changes the channel /start attempts", async () => {
    const before = await app.inject({
      method: "POST",
      url: "/v1/verification/start",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { phone_number: "+919876543210" },
    });
    expect(before.json().channel_attempted).toBe("whatsapp");

    const putRes = await app.inject({
      method: "PUT",
      url: "/v1/accounts/me/routing-policy",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { version: 1, rules: [], default: { channels: ["sms"] } },
    });
    expect(putRes.statusCode).toBe(200);

    const after = await app.inject({
      method: "POST",
      url: "/v1/verification/start",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { phone_number: "+919876543210" },
    });
    expect(after.json().channel_attempted).toBe("sms");
  });

  it("a rule matching the request's country picks that rule's channels and timeouts", async () => {
    await app.inject({
      method: "PUT",
      url: "/v1/accounts/me/routing-policy",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        version: 1,
        rules: [
          {
            match: { country: "IN" },
            channels: ["sms", "whatsapp"],
            timeouts_ms: { sms: 5000, whatsapp: 9000 },
          },
        ],
        default: { channels: ["whatsapp"] },
      },
    });

    const startRes = await app.inject({
      method: "POST",
      url: "/v1/verification/start",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { phone_number: "+919876543210" },
    });
    expect(startRes.json().channel_attempted).toBe("sms");

    const [verification] = await infra.pg`
      SELECT channel_chain, channel_timeouts_ms FROM verifications WHERE id = ${startRes.json().verification_id}
    `;
    expect(verification?.channel_chain).toEqual(["sms", "whatsapp"]);
    expect(verification?.channel_timeouts_ms).toEqual({ sms: 5000, whatsapp: 9000 });
  });

  // R3.9/R3.10: the decision log explains every skip — here, a cost ceiling excludes
  // whatsapp, and the log says exactly why.
  it("persists a routing_decisions row whose log explains a cost-ceiling skip", async () => {
    await insertProviderRate(infra.pg, {
      id: "rate_whatsapp_in",
      provider: "meta",
      channel: "whatsapp",
      country: "IN",
      messageType: "authentication",
      rateMicros: 2_000_000,
      currency: "INR",
      effectiveFrom: new Date("2020-01-01T00:00:00Z"),
    });
    // sms priced within budget — an unpriced channel now fails the ceiling closed
    // (apply-cost-ceiling.ts), so sms needs its own rate on file to survive on merit
    // rather than by the absence of one.
    await insertProviderRate(infra.pg, {
      id: "rate_sms_in",
      provider: "generic_sms",
      channel: "sms",
      country: "IN",
      messageType: "authentication",
      rateMicros: 150_000,
      currency: "INR",
      effectiveFrom: new Date("2020-01-01T00:00:00Z"),
    });
    await app.inject({
      method: "PUT",
      url: "/v1/accounts/me/routing-policy",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        version: 1,
        rules: [
          { match: { country: "IN" }, channels: ["whatsapp", "sms"], max_cost_micros: 1_000_000 },
        ],
        default: { channels: ["sms"] },
      },
    });

    const startRes = await app.inject({
      method: "POST",
      url: "/v1/verification/start",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { phone_number: "+919876543210" },
    });
    expect(startRes.json().channel_attempted).toBe("sms");

    const [decision] = await infra.pg`
      SELECT chosen_channel, decision_log_json, considered_json FROM routing_decisions
      WHERE verification_id = ${startRes.json().verification_id}
    `;
    expect(decision?.chosen_channel).toBe("sms");
    expect(decision?.considered_json).toEqual(["whatsapp", "sms"]);
    expect(findSkipReason(decision?.decision_log_json, "whatsapp")).toMatch(/cost ceiling/);
  });

  // R3.6: two consecutive failures on this number/channel drop it from the chain
  // entirely — visible in both the chosen channel and the decision log.
  it("a channel with two consecutive failures for this number is dropped, and the log says why", async () => {
    // phone_hash for +919876543210 under PHONE_HASH_PEPPER — computed the same way the
    // route does, via hashPhone, so this test doesn't hardcode a magic string.
    const phoneHash = hashPhone("+919876543210", PHONE_HASH_PEPPER);
    await upsertCapability(infra.pg, phoneHash, {
      channel: "whatsapp",
      capability: "unlikely",
      confidence: 0.1,
      lastSuccessAt: null,
      consecutiveFailures: 2,
      updatedAt: new Date(),
    });

    const startRes = await app.inject({
      method: "POST",
      url: "/v1/verification/start",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { phone_number: "+919876543210" },
    });
    expect(startRes.json().channel_attempted).toBe("sms");

    const [decision] = await infra.pg`
      SELECT decision_log_json FROM routing_decisions WHERE verification_id = ${startRes.json().verification_id}
    `;
    expect(findSkipReason(decision?.decision_log_json, "whatsapp")).toMatch(/consecutive failures/);
  });
});
