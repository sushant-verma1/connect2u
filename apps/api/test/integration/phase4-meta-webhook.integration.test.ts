import { createHmac } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Worker } from "bullmq";
import { Redis } from "ioredis";
import { pino } from "pino";
import { insertAccount } from "@otp-router/db/repositories/accounts";
import { insertVerification } from "@otp-router/db/repositories/verifications";
import { insertDeliveryAttempt } from "@otp-router/db/repositories/delivery-attempts";
import { createWebhookIngestWorker } from "@otp-router/worker/queue/webhook-worker";
import { closeQueues, createQueues, type Queues } from "@otp-router/worker/queue/queues";
import { buildApp } from "../../src/app.js";
import { generateApiKey, hashApiKey } from "../../src/crypto/api-key.js";
import { startInfra, truncateAll, type Infra } from "./harness.js";

const OTP_PEPPER = "test-otp-pepper";
const PHONE_HASH_PEPPER = "test-phone-hash-pepper";
const API_KEY_PEPPER = "test-api-key-pepper";
const PHONE_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
const CODE_ENCRYPTION_KEY = Buffer.alloc(32, 10).toString("base64");
const META_APP_SECRET = "test-meta-app-secret";
const META_WEBHOOK_VERIFY_TOKEN = "test-meta-verify-token";

const config = {
  nodeEnv: "test" as const,
  port: 0,
  logLevel: "silent" as const,
  databaseUrl: "",
  redisUrl: "",
  otpPepper: OTP_PEPPER,
  phoneHashPepper: PHONE_HASH_PEPPER,
  apiKeyPepper: API_KEY_PEPPER,
  phoneEncryptionKey: PHONE_ENCRYPTION_KEY,
  codeEncryptionKey: CODE_ENCRYPTION_KEY,
  metaAppSecret: META_APP_SECRET,
  metaWebhookVerifyToken: META_WEBHOOK_VERIFY_TOKEN,
};

const keys = { phoneEncryptionKey: PHONE_ENCRYPTION_KEY, codeEncryptionKey: CODE_ENCRYPTION_KEY };
const logger = pino({ level: "silent" });

function metaSignatureFor(rawBody: string): string {
  return `sha256=${createHmac("sha256", META_APP_SECRET).update(rawBody).digest("hex")}`;
}

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
let workerQueueConnection: Redis;
let webhookConnection: Redis;
let app: FastifyInstance;
let queues: Queues;
let webhookWorker: Worker;
let accountId: string;

async function seedAccount(name: string): Promise<string> {
  const { fullKey, prefix } = generateApiKey("test");
  const apiKeyHash = await hashApiKey(fullKey, API_KEY_PEPPER);
  const account = await insertAccount(infra.pg, {
    id: `acct_${prefix}`,
    name,
    apiKeyHash,
    apiKeyPrefix: prefix,
    status: "active",
  });
  return account.id;
}

/** Seeds a `sent` delivery attempt with a Meta-shaped provider_message_id, bypassing
 * the send path entirely — this suite is about the webhook route, not delivery. */
async function seedSentMetaAttempt(): Promise<{
  verificationId: string;
  providerMessageId: string;
}> {
  const verificationId = `ver_${Date.now()}`;
  await insertVerification(infra.pg, {
    id: verificationId,
    accountId,
    phoneHash: "hash",
    phoneEncrypted: "enc",
    codeHmac: "hmac",
    codeEncrypted: "enc",
    channelChain: ["whatsapp", "sms"],
    expiresAt: new Date(Date.now() + 300_000),
  });
  const providerMessageId = `wamid.${Date.now()}`;
  await insertDeliveryAttempt(infra.pg, {
    id: `att_${Date.now()}`,
    verificationId,
    accountId,
    channel: "whatsapp",
    provider: "meta",
    providerMessageId,
    status: "sent",
    sentAt: new Date(),
  });
  return { verificationId, providerMessageId };
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
  await truncateAll(infra.pg);
  accountId = await seedAccount("Acme");
  bullConnection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  workerQueueConnection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  webhookConnection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  queues = createQueues(workerQueueConnection);
  webhookWorker = createWebhookIngestWorker(webhookConnection, infra.pg, logger, queues, keys);
  app = await buildApp(config, infra.pg, infra.redis, bullConnection);
});

afterEach(async () => {
  await app.close();
  await webhookWorker.close();
  await closeQueues(queues);
  bullConnection.disconnect();
  workerQueueConnection.disconnect();
  webhookConnection.disconnect();
});

describe("Phase 4 — Meta webhook", () => {
  it("GET handshake echoes the challenge only when the verify token matches", async () => {
    const ok = await app.inject({
      method: "GET",
      url: "/v1/webhooks/meta?hub.mode=subscribe&hub.verify_token=test-meta-verify-token&hub.challenge=echo-me",
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe("echo-me");

    const wrongToken = await app.inject({
      method: "GET",
      url: "/v1/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=echo-me",
    });
    expect(wrongToken.statusCode).toBe(403);
  });

  // R6.1: signature verification happens before any parsing or database work — a bad
  // signature must be rejected without ever reaching the ingest queue or the DB.
  it("rejects a POST with an invalid X-Hub-Signature-256 before touching the database", async () => {
    const { providerMessageId } = await seedSentMetaAttempt();
    const body = JSON.stringify({
      entry: [
        { changes: [{ value: { statuses: [{ id: providerMessageId, status: "delivered" }] } }] },
      ],
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/meta",
      headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=deadbeef" },
      payload: body,
    });
    expect(res.statusCode).toBe(401);

    const events = await infra.pg`SELECT id FROM webhook_events`;
    expect(events).toHaveLength(0);
  });

  it("rejects a POST with no signature header at all", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/meta",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ entry: [] }),
    });
    expect(res.statusCode).toBe(401);
  });

  it("a validly signed delivered status resolves the attempt and records signature_valid", async () => {
    const { providerMessageId } = await seedSentMetaAttempt();
    const body = JSON.stringify({
      entry: [
        { changes: [{ value: { statuses: [{ id: providerMessageId, status: "delivered" }] } }] },
      ],
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/meta",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": metaSignatureFor(body),
      },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accepted: true });

    await waitFor(async () => {
      const [attempt] = await infra.pg`
        SELECT status FROM delivery_attempts WHERE provider_message_id = ${providerMessageId}
      `;
      return attempt?.status === "delivered";
    });

    const [event] = await infra.pg`
      SELECT signature_valid, provider FROM webhook_events WHERE provider_message_id = ${providerMessageId}
    `;
    expect(event?.signature_valid).toBe(true);
    expect(event?.provider).toBe("meta");
  });
});
