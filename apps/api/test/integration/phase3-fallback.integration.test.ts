import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Worker } from "bullmq";
import { Redis } from "ioredis";
import { pino } from "pino";
import { insertAccount } from "@otp-router/db/repositories/accounts";
import { findVerificationScoped } from "@otp-router/db/repositories/verifications";
import { SimulatedProvider } from "@otp-router/providers/simulated";
import { createDeliveryWorker } from "@otp-router/worker/queue/delivery-worker";
import { createFallbackTimerWorker } from "@otp-router/worker/queue/fallback-worker";
import { closeQueues, createQueues, type Queues } from "@otp-router/worker/queue/queues";
import { createWebhookIngestWorker } from "@otp-router/worker/queue/webhook-worker";
import { buildApp } from "../../src/app.js";
import { generateApiKey, hashApiKey } from "../../src/crypto/api-key.js";
import { startInfra, truncateAll, type Infra } from "./harness.js";

const OTP_PEPPER = "test-otp-pepper";
const PHONE_HASH_PEPPER = "test-phone-hash-pepper";
const API_KEY_PEPPER = "test-api-key-pepper";
const PHONE_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
const CODE_ENCRYPTION_KEY = Buffer.alloc(32, 10).toString("base64");
const keys = { phoneEncryptionKey: PHONE_ENCRYPTION_KEY, codeEncryptionKey: CODE_ENCRYPTION_KEY };

// Fast, deterministic timeouts for the race tests below — production uses
// ARCHITECTURE.md §4's 20s/30s. What's under test is who wins a race, not real timing.
const FAST_TIMEOUT_MS = { whatsapp: 150, sms: 150 };

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
};

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
let workerQueueConnection: Redis;
let deliveryConnection: Redis;
let fallbackConnection: Redis;
let webhookConnection: Redis;
let app: FastifyInstance;
let queues: Queues;
let deliveryWorker: Worker;
let fallbackWorker: Worker;
let webhookWorker: Worker;
let provider: SimulatedProvider;
let accountId: string;
let apiKey: string;

async function seedAccount(name: string): Promise<{ accountId: string; apiKey: string }> {
  const { fullKey, prefix } = generateApiKey("test");
  const apiKeyHash = await hashApiKey(fullKey, API_KEY_PEPPER);
  const account = await insertAccount(infra.pg, {
    id: `acct_${prefix}`,
    name,
    apiKeyHash,
    apiKeyPrefix: prefix,
    status: "active",
  });
  return { accountId: account.id, apiKey: fullKey };
}

function requireMessageId(value: string | null | undefined): string {
  if (!value) {
    throw new Error("expected a provider_message_id");
  }
  return value;
}

/** Waits until the Nth (0-indexed) delivery attempt has actually been sent — row
 * existence alone only proves /start's synchronous insert ran, not that the worker has
 * processed it (R1.1.5: those are decoupled by design). */
async function waitForSent(verificationId: string, index: number): Promise<void> {
  await waitFor(async () => {
    const attempts = await attemptsFor(verificationId);
    return attempts[index]?.status === "sent";
  });
}

async function attemptsFor(
  verificationId: string,
): Promise<readonly { channel: string; status: string; provider_message_id: string | null }[]> {
  return infra.pg`
    SELECT channel, status, provider_message_id FROM delivery_attempts
    WHERE verification_id = ${verificationId} ORDER BY id
  `;
}

beforeAll(async () => {
  infra = await startInfra();
  config.databaseUrl = infra.databaseUrl;
  config.redisUrl = infra.redisUrl;
}, 120_000);

afterAll(async () => {
  // Guard against beforeAll having thrown (e.g. Docker isn't running) — infra is
  // never assigned, and calling infra.stop() would report a confusing second
  // failure on top of the real one.
  await infra?.stop();
});

beforeEach(async () => {
  await truncateAll(infra.pg);
  ({ accountId, apiKey } = await seedAccount("Acme"));
  // Separate connections for the app's own queues vs. the worker-side queues used to
  // build the processors below — mirrors production, where these are two different
  // OS processes and never share a physical connection.
  bullConnection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  workerQueueConnection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  queues = createQueues(workerQueueConnection);
  // Every SimulatedProvider send succeeds immediately — these tests are about webhook
  // and timer races, not send failures (those are covered in phase2-delivery).
  provider = new SimulatedProvider({ latencyMs: 0 });
  // Each Worker gets its own connection — see apps/worker/src/index.ts's
  // `createConnection` comment. Sharing one connection across three Workers (or a
  // Worker and a Queue producer) means an idle Worker's blocking read stalls every
  // other command queued behind it on that socket.
  deliveryConnection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  fallbackConnection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  webhookConnection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  deliveryWorker = createDeliveryWorker(
    deliveryConnection,
    infra.pg,
    provider,
    logger,
    queues,
    keys,
    FAST_TIMEOUT_MS,
  );
  fallbackWorker = createFallbackTimerWorker(fallbackConnection, infra.pg, logger, queues, keys);
  webhookWorker = createWebhookIngestWorker(webhookConnection, infra.pg, logger, queues, keys);
  app = await buildApp(config, infra.pg, infra.redis, bullConnection);
});

afterEach(async () => {
  await app.close();
  await Promise.all([deliveryWorker.close(), fallbackWorker.close(), webhookWorker.close()]);
  await closeQueues(queues);
  bullConnection.disconnect();
  workerQueueConnection.disconnect();
  deliveryConnection.disconnect();
  fallbackConnection.disconnect();
  webhookConnection.disconnect();
});

describe("Phase 3 — fallback and webhook races", () => {
  // T5: late delivery after fallback fired still verifies (R4.8, R2.3). WhatsApp is
  // sent but never confirmed; the fallback timer fires, SMS is tried; the user then
  // enters the code from the (slow, but genuine) WhatsApp message and still succeeds —
  // proof the code was never regenerated for the second channel.
  it("T5 — late delivery after fallback fired still verifies", async () => {
    const startRes = await app.inject({
      method: "POST",
      url: "/v1/verification/start",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { phone_number: "+919876543210" },
    });
    const { verification_id: verificationId } = startRes.json();

    // Wait for the WhatsApp attempt to be sent, then for its fallback timer to fire and
    // advance the chain to SMS.
    await waitForSent(verificationId, 0);
    const code = provider.sentMessages[0]?.code;
    expect(code).toMatch(/^\d{6}$/);

    await waitFor(async () => {
      const attempts = await attemptsFor(verificationId);
      return attempts.length === 2 && attempts[0]?.status === "timed_out";
    }, 5000);

    const attemptsAfterFallback = await attemptsFor(verificationId);
    expect(attemptsAfterFallback.map((a) => a.channel)).toEqual(["whatsapp", "sms"]);

    // The late webhook: WhatsApp actually delivered, just after the timer already fired.
    const whatsappMessageId = requireMessageId(attemptsAfterFallback[0]?.provider_message_id);
    const lateWebhookRes = await app.inject({
      method: "POST",
      url: "/v1/webhooks/simulated",
      payload: { provider_message_id: whatsappMessageId, event_type: "delivered" },
    });
    expect(lateWebhookRes.statusCode).toBe(200);

    // R4.8: the late confirmation is a no-op against an already-timed-out attempt —
    // it does not resurrect it or change the verification's ability to succeed.
    await waitFor(async () => {
      const events =
        await infra.pg`SELECT id FROM webhook_events WHERE provider_message_id = ${whatsappMessageId}`;
      return events.length === 1;
    });
    const [whatsappAttempt] = await attemptsFor(verificationId);
    expect(whatsappAttempt?.status).toBe("timed_out");

    // The user still checks in with the code the (slow) WhatsApp message carried —
    // same code, never regenerated (R2.3) — and it verifies.
    const checkRes = await app.inject({
      method: "POST",
      url: "/v1/verification/check",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { verification_id: verificationId, code },
    });
    expect(checkRes.statusCode).toBe(200);
    expect(checkRes.json().status).toBe("verified");
  });

  // T6: duplicate webhook causes exactly one state transition (R6.2). The
  // webhook_events unique index is the mechanism, not application-level bookkeeping.
  it("T6 — a duplicate webhook causes exactly one state transition", async () => {
    const startRes = await app.inject({
      method: "POST",
      url: "/v1/verification/start",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { phone_number: "+919876543210" },
    });
    const { verification_id: verificationId } = startRes.json();

    await waitForSent(verificationId, 0);
    const [attempt] = await attemptsFor(verificationId);
    const messageId = requireMessageId(attempt?.provider_message_id);

    const payload = { provider_message_id: messageId, event_type: "delivered" as const };
    const [first, second] = await Promise.all([
      app.inject({ method: "POST", url: "/v1/webhooks/simulated", payload }),
      app.inject({ method: "POST", url: "/v1/webhooks/simulated", payload }),
    ]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    await waitFor(async () => {
      const [current] = await attemptsFor(verificationId);
      return current?.status === "delivered";
    });

    // Exactly one webhook_events row for this (provider, message id, event type) — the
    // duplicate never got past the unique index, regardless of concurrent arrival.
    const events = await infra.pg`
      SELECT id FROM webhook_events WHERE provider_message_id = ${messageId} AND event_type = 'delivered'
    `;
    expect(events).toHaveLength(1);

    const [current] = await attemptsFor(verificationId);
    expect(current?.status).toBe("delivered");
  });

  // T7: out-of-order webhooks yield the correct terminal state. A `failed` event
  // resolves the attempt and advances the chain; a `delivered` event that arrives
  // afterward for the same (now-resolved) attempt is a no-op, not a state corruption.
  it("T7 — an out-of-order webhook against an already-resolved attempt is a no-op", async () => {
    const startRes = await app.inject({
      method: "POST",
      url: "/v1/verification/start",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { phone_number: "+919876543210" },
    });
    const { verification_id: verificationId } = startRes.json();

    await waitForSent(verificationId, 0);
    const [whatsappAttempt] = await attemptsFor(verificationId);
    const messageId = requireMessageId(whatsappAttempt?.provider_message_id);

    const failedRes = await app.inject({
      method: "POST",
      url: "/v1/webhooks/simulated",
      payload: { provider_message_id: messageId, event_type: "failed" },
    });
    expect(failedRes.statusCode).toBe(200);

    // The failure resolves the attempt and advances the chain to SMS.
    await waitFor(async () => (await attemptsFor(verificationId)).length === 2);
    let [resolvedWhatsapp] = await attemptsFor(verificationId);
    expect(resolvedWhatsapp?.status).toBe("failed");

    // Arriving "late" / out of order: a delivered event for the same message id.
    const deliveredRes = await app.inject({
      method: "POST",
      url: "/v1/webhooks/simulated",
      payload: { provider_message_id: messageId, event_type: "delivered" },
    });
    expect(deliveredRes.statusCode).toBe(200);

    // Wait for the ingest queue to actually process the second event before asserting
    // on its outcome — an empty queue is the only reliable signal that it ran.
    await waitFor(async () => {
      const counts = await queues.webhookIngestQueue.getJobCounts("waiting", "active", "delayed");
      return counts.waiting === 0 && counts.active === 0 && counts.delayed === 0;
    });

    // R6.2: dedupe is keyed on (provider, provider_message_id) alone, so this second
    // event for the same message never becomes a second `webhook_events` row — it's a
    // duplicate at the DB level regardless of its event_type, not merely a no-op that
    // the application layer decided to ignore.
    const events =
      await infra.pg`SELECT id FROM webhook_events WHERE provider_message_id = ${messageId}`;
    expect(events).toHaveLength(1);
    [resolvedWhatsapp] = await attemptsFor(verificationId);
    expect(resolvedWhatsapp?.status).toBe("failed");
  });

  // T8: a success webhook racing the fallback timer results in exactly one channel
  // used. The webhook wins here (it's posted immediately, well inside the timeout
  // window) — the timer still fires later and must be a no-op (R4.3/I9), not a second
  // send.
  it("T8 — a success webhook racing the fallback timer results in exactly one channel used", async () => {
    const startRes = await app.inject({
      method: "POST",
      url: "/v1/verification/start",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { phone_number: "+919876543210" },
    });
    const { verification_id: verificationId } = startRes.json();

    await waitForSent(verificationId, 0);
    const [attempt] = await attemptsFor(verificationId);
    const messageId = requireMessageId(attempt?.provider_message_id);

    // The webhook wins the race — posted well before FAST_TIMEOUT_MS elapses.
    const deliveredRes = await app.inject({
      method: "POST",
      url: "/v1/webhooks/simulated",
      payload: { provider_message_id: messageId, event_type: "delivered" },
    });
    expect(deliveredRes.statusCode).toBe(200);

    await waitFor(async () => {
      const [current] = await attemptsFor(verificationId);
      return current?.status === "delivered";
    });

    // Wait past the original timer delay — it still fires, but against an attempt that
    // is no longer `sent`, so it must no-op rather than starting a second channel.
    await new Promise((resolve) => setTimeout(resolve, FAST_TIMEOUT_MS.whatsapp + 200));

    const attempts = await attemptsFor(verificationId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe("delivered");

    const verification = await findVerificationScoped(infra.pg, verificationId, accountId);
    expect(verification?.status).toBe("pending");
  });
});
