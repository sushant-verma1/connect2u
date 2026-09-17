import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Worker } from "bullmq";
import { Redis } from "ioredis";
import { pino } from "pino";
import { upsertCapability } from "@otp-router/db/repositories/channel-capability";
import { SimulatedProvider } from "@otp-router/providers/simulated";
import { createDeliveryWorker } from "@otp-router/worker/queue/delivery-worker";
import { createWebhookIngestWorker } from "@otp-router/worker/queue/webhook-worker";
import { closeQueues, createQueues, type Queues } from "@otp-router/worker/queue/queues";
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
const keys = { phoneEncryptionKey: PHONE_ENCRYPTION_KEY, codeEncryptionKey: CODE_ENCRYPTION_KEY };
const logger = pino({ level: "silent" });

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: condition not met within timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

let infra: Infra;
let bullConnection: Redis;
let deliveryConnection: Redis;
let webhookConnection: Redis;
let deliveryWorker: Worker;
let webhookWorker: Worker;
let app: FastifyInstance;
let queues: Queues;
let apiKey: string;
let provider: SimulatedProvider;

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
  deliveryConnection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  webhookConnection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  queues = createQueues(bullConnection);
  provider = new SimulatedProvider({ latencyMs: 0 });
  deliveryWorker = createDeliveryWorker(
    deliveryConnection,
    infra.pg,
    provider,
    logger,
    queues,
    keys,
  );
  webhookWorker = createWebhookIngestWorker(webhookConnection, infra.pg, logger, queues, keys);
  app = await buildApp(config, infra.pg, infra.redis, bullConnection);
});

afterEach(async () => {
  await app.close();
  await Promise.all([deliveryWorker.close(), webhookWorker.close()]);
  await closeQueues(queues);
  bullConnection.disconnect();
  deliveryConnection.disconnect();
  webhookConnection.disconnect();
});

describe("Phase 8 — GET /v1/verification/:id/trace (R10.6)", () => {
  it("shows the routing decision's skip reason, the attempt, and its webhook event", async () => {
    const phoneNumber = "+919876543210";
    const phoneHash = hashPhone(phoneNumber, PHONE_HASH_PEPPER);

    // R3.6: two consecutive failures already on record for WhatsApp on this number —
    // filter-by-capability.ts drops it before any send is attempted, so the chain this
    // verification actually runs is SMS-only, with a decision-log entry explaining why.
    await upsertCapability(infra.pg, phoneHash, {
      channel: "whatsapp",
      capability: "unlikely",
      confidence: 0.2,
      lastSuccessAt: null,
      consecutiveFailures: 2,
      updatedAt: new Date(),
    });

    const startRes = await app.inject({
      method: "POST",
      url: "/v1/verification/start",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { phone_number: phoneNumber },
    });
    expect(startRes.statusCode).toBe(202);
    expect(startRes.json().channel_attempted).toBe("sms");
    const { verification_id: verificationId } = startRes.json();

    // provider.sentMessages is populated inside SimulatedProvider.send(), before the
    // caller (the delivery processor) goes on to look up the rate and write
    // provider_message_id to Postgres — waiting on the DB write itself, not on the
    // provider's own bookkeeping, is what actually proves the attempt is ready.
    await waitFor(async () => {
      const [attempt] = await infra.pg`
        SELECT provider_message_id FROM delivery_attempts WHERE verification_id = ${verificationId}
      `;
      return attempt?.provider_message_id != null;
    });

    const [attemptRow] = await infra.pg`
      SELECT provider_message_id FROM delivery_attempts WHERE verification_id = ${verificationId}
    `;
    const providerMessageId: string = attemptRow?.provider_message_id;
    expect(providerMessageId).toBeTruthy();

    const webhookRes = await app.inject({
      method: "POST",
      url: "/v1/webhooks/simulated",
      payload: { provider_message_id: providerMessageId, event_type: "delivered" },
    });
    expect(webhookRes.statusCode).toBe(200);

    await waitFor(async () => {
      const [attempt] = await infra.pg`
        SELECT status FROM delivery_attempts WHERE verification_id = ${verificationId}
      `;
      return attempt?.status === "delivered";
    });

    const traceRes = await app.inject({
      method: "GET",
      url: `/v1/verification/${verificationId}/trace`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(traceRes.statusCode).toBe(200);
    const trace = traceRes.json();

    expect(trace.verification_id).toBe(verificationId);
    expect(trace.channel_chain).toEqual(["sms"]);

    // R3.9/R10.6: the reason WhatsApp never appears in channel_chain is right here.
    const skip = trace.routing_decision.decision_log.find(
      (entry: { channel?: string; action: string }) =>
        entry.channel === "whatsapp" && entry.action === "skipped",
    );
    expect(skip).toBeDefined();
    expect(skip.stage).toBe("capability_filter");
    expect(skip.reason).toMatch(/consecutive failures/);

    expect(trace.attempts).toHaveLength(1);
    const [smsAttempt] = trace.attempts;
    expect(smsAttempt.channel).toBe("sms");
    expect(smsAttempt.status).toBe("delivered");
    expect(smsAttempt.webhook_events).toHaveLength(1);
    expect(smsAttempt.webhook_events[0].event_type).toBe("delivered");
  });

  it("scopes by account — a verification ID from another account is a 404, not another account's trace", async () => {
    const startRes = await app.inject({
      method: "POST",
      url: "/v1/verification/start",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { phone_number: "+919876543210" },
    });
    const { verification_id: verificationId } = startRes.json();

    const other = await seedAccount("Other");
    const traceRes = await app.inject({
      method: "GET",
      url: `/v1/verification/${verificationId}/trace`,
      headers: { authorization: `Bearer ${other.apiKey}` },
    });
    expect(traceRes.statusCode).toBe(404);
  });
});
