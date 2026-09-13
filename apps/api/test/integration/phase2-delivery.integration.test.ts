import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { pino } from "pino";
import { insertAccount } from "@otp-router/db/repositories/accounts";
import { findVerificationScoped } from "@otp-router/db/repositories/verifications";
import { insertProviderRate } from "@otp-router/db/repositories/provider-rates";
import { MAX_FALLBACK_CHANNELS } from "@otp-router/core/fallback/channel-chain";
import type {
  Provider,
  ProviderError,
  SendParams,
  SendResult,
} from "@otp-router/providers/provider";
import { SimulatedProvider } from "@otp-router/providers/simulated";
import { DELIVERY_QUEUE_NAME, type DeliveryJobData } from "@otp-router/core/queue/delivery-job";
import { createDeliveryProcessor } from "@otp-router/worker/processors/delivery";
import { closeQueues, createQueues, type Queues } from "@otp-router/worker/queue/queues";
import { buildApp } from "../../src/app.js";
import { generateApiKey, hashApiKey } from "../../src/crypto/api-key.js";
import { startInfra, truncateAll, type Infra } from "./harness.js";

const OTP_PEPPER = "test-otp-pepper";
const PHONE_HASH_PEPPER = "test-phone-hash-pepper";
const API_KEY_PEPPER = "test-api-key-pepper";
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
  phoneEncryptionKey: PHONE_ENCRYPTION_KEY,
  codeEncryptionKey: CODE_ENCRYPTION_KEY,
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
let app: FastifyInstance;
let queues: Queues;
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
  bullConnection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  queues = createQueues(bullConnection);
  app = await buildApp(config, infra.pg, infra.redis, bullConnection);
});

afterEach(async () => {
  await app.close();
  await closeQueues(queues);
  bullConnection.disconnect();
});

describe("Phase 2 — async delivery", () => {
  // R1.1.5: this is only enforceable now that /start no longer awaits the provider.
  it("/start responds under 100ms even when the provider takes 5s to answer", async () => {
    const worker = new Worker<DeliveryJobData>(
      DELIVERY_QUEUE_NAME,
      createDeliveryProcessor({
        pg: infra.pg,
        provider: new SlowProvider(5000),
        logger,
        deadLetterQueue: queues.deadLetterQueue,
        deliveryQueue: queues.deliveryQueue,
        fallbackQueue: queues.fallbackQueue,
        keys,
      }),
      { connection: bullConnection },
    );

    try {
      // Warm up route compilation/JIT once before timing — the assertion is about the
      // request path never blocking on the provider, not about cold-start overhead.
      await app.inject({
        method: "POST",
        url: "/v1/verification/start",
        headers: { authorization: `Bearer ${apiKey}` },
        payload: { phone_number: "+919876543210" },
      });

      const startedAt = Date.now();
      const res = await app.inject({
        method: "POST",
        url: "/v1/verification/start",
        headers: { authorization: `Bearer ${apiKey}` },
        payload: { phone_number: "+919876543210" },
      });
      const elapsedMs = Date.now() - startedAt;

      expect(res.statusCode).toBe(202);
      expect(elapsedMs).toBeLessThan(100);
    } finally {
      await worker.close();
    }
  });

  // Exit gate: a worker killed mid-delivery and restarted must resume cleanly — no
  // duplicate send, no lost verification. The "crash" is modelled as a send() call
  // that never resolves — indistinguishable, from Postgres's point of view, from a
  // process that died before the provider call returned.
  it("resumes cleanly after the worker is killed mid-delivery: no duplicate send, no lost verification", async () => {
    const provider = new HangOnceProvider();
    const workerOptions = { connection: bullConnection, lockDuration: 200, stalledInterval: 100 };
    const processDelivery = createDeliveryProcessor({
      pg: infra.pg,
      provider,
      logger,
      deadLetterQueue: queues.deadLetterQueue,
      deliveryQueue: queues.deliveryQueue,
      fallbackQueue: queues.fallbackQueue,
      keys,
    });

    const worker1 = new Worker<DeliveryJobData>(
      DELIVERY_QUEUE_NAME,
      processDelivery,
      workerOptions,
    );

    const startRes = await app.inject({
      method: "POST",
      url: "/v1/verification/start",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { phone_number: "+919876543210" },
    });
    expect(startRes.statusCode).toBe(202);
    const { verification_id: verificationId } = startRes.json();

    // Wait until worker1 has picked up the job and is stuck inside the hanging send().
    await waitFor(() => provider.callCount === 1);

    // Simulate a hard kill: no graceful drain, no lock release.
    await worker1.close(true);

    // "Restart": a fresh worker instance, same provider (now past its one hang).
    const worker2 = new Worker<DeliveryJobData>(
      DELIVERY_QUEUE_NAME,
      processDelivery,
      workerOptions,
    );

    try {
      await waitFor(async () => {
        const rows = await infra.pg`
          SELECT status FROM delivery_attempts WHERE verification_id = ${verificationId}
        `;
        return rows[0]?.status === "sent";
      }, 10_000);

      // No duplicate send: the hung first call never completed, so only the second
      // (post-restart) call ever produced an observable delivery.
      expect(provider.completedSends).toHaveLength(1);

      // No lost verification: the code from the completed send still verifies.
      const code = provider.completedSends[0]?.code;
      expect(code).toMatch(/^\d{6}$/);

      const checkRes = await app.inject({
        method: "POST",
        url: "/v1/verification/check",
        headers: { authorization: `Bearer ${apiKey}` },
        payload: { verification_id: verificationId, code },
      });
      expect(checkRes.statusCode).toBe(200);
      expect(checkRes.json().status).toBe("verified");

      const verification = await findVerificationScoped(infra.pg, verificationId, accountId);
      expect(verification?.status).toBe("verified");
    } finally {
      await worker2.close();
    }
  });

  // R5.6: a permanent error (invalid_number) must fail on the first attempt of *each*
  // channel — never retried within a channel — while still advancing the fallback
  // chain (R4.4 trigger #1) to the next one. Both channels are equally invalid here, so
  // the chain runs to exhaustion and the verification terminates as `failed`.
  it("a permanent provider error does not retry within a channel, but does advance the fallback chain", async () => {
    const provider = new SimulatedProvider({
      latencyMs: 0,
      failureRate: 1,
      failureCode: "invalid_number",
    });
    const worker = new Worker<DeliveryJobData>(
      DELIVERY_QUEUE_NAME,
      createDeliveryProcessor({
        pg: infra.pg,
        provider,
        logger,
        deadLetterQueue: queues.deadLetterQueue,
        deliveryQueue: queues.deliveryQueue,
        fallbackQueue: queues.fallbackQueue,
        keys,
      }),
      { connection: bullConnection },
    );

    try {
      const startRes = await app.inject({
        method: "POST",
        url: "/v1/verification/start",
        headers: { authorization: `Bearer ${apiKey}` },
        payload: { phone_number: "+919876543210" },
      });
      const { verification_id: verificationId } = startRes.json();

      await waitFor(async () => {
        const verification = await findVerificationScoped(infra.pg, verificationId, accountId);
        return verification?.status === "failed";
      });

      const attempts = await infra.pg`
        SELECT channel, status, error_code FROM delivery_attempts
        WHERE verification_id = ${verificationId} ORDER BY channel
      `;
      // Default chain is [whatsapp, sms] — both exhausted, each tried exactly once.
      expect(attempts).toHaveLength(2);
      for (const attempt of attempts) {
        expect(attempt.status).toBe("failed");
        expect(attempt.error_code).toBe("invalid_number");
      }

      // One send per channel — a transient error would have retried the same channel
      // up to 5 times; a permanent one never retries, it only advances.
      expect(provider.sentMessages).toHaveLength(2);

      const deadLetters = await queues.deadLetterQueue.getJobs(["waiting"]);
      const records = deadLetters.filter((job) => job.data.verificationId === verificationId);
      expect(records).toHaveLength(2);
      for (const record of records) {
        expect(record.data.errorCode).toBe("invalid_number");
        expect(record.data.attemptsMade).toBe(1);
      }
    } finally {
      await worker.close();
    }
  });

  // R4.7: the chain is capped at MAX_FALLBACK_CHANNELS regardless of how many channels
  // a customer requests. Requesting more than the cap must not persist (or run through)
  // a longer chain — it stops at the cap and, once that capped chain is exhausted,
  // terminates as `failed`.
  it("a chain longer than MAX_FALLBACK_CHANNELS is capped and still terminates as failed", async () => {
    const provider = new SimulatedProvider({
      latencyMs: 0,
      failureRate: 1,
      failureCode: "invalid_number",
    });
    const worker = new Worker<DeliveryJobData>(
      DELIVERY_QUEUE_NAME,
      createDeliveryProcessor({
        pg: infra.pg,
        provider,
        logger,
        deadLetterQueue: queues.deadLetterQueue,
        deliveryQueue: queues.deliveryQueue,
        fallbackQueue: queues.fallbackQueue,
        keys,
      }),
      { connection: bullConnection },
    );

    try {
      // Phase 5: routing owns the channel list now — a customer's `channels` in the
      // /start body only *filters* the policy's proposed set (matchPolicy.ts), it no
      // longer supplies the raw (possibly duplicate-heavy) list directly. To exercise
      // the cap, the duplicates have to live in the policy itself.
      await app.inject({
        method: "PUT",
        url: "/v1/accounts/me/routing-policy",
        headers: { authorization: `Bearer ${apiKey}` },
        payload: {
          version: 1,
          rules: [],
          default: { channels: ["whatsapp", "sms", "whatsapp", "sms", "whatsapp"] },
        },
      });

      const startRes = await app.inject({
        method: "POST",
        url: "/v1/verification/start",
        headers: { authorization: `Bearer ${apiKey}` },
        payload: { phone_number: "+919876543210" },
      });
      const { verification_id: verificationId } = startRes.json();

      const [verification] = await infra.pg`
        SELECT channel_chain FROM verifications WHERE id = ${verificationId}
      `;
      expect(verification?.channel_chain).toHaveLength(MAX_FALLBACK_CHANNELS);

      await waitFor(async () => {
        const current = await findVerificationScoped(infra.pg, verificationId, accountId);
        return current?.status === "failed";
      });

      const attempts = await infra.pg`
        SELECT channel, status FROM delivery_attempts
        WHERE verification_id = ${verificationId} ORDER BY id
      `;
      // Only 2 distinct channels exist today, so the capped chain (whatsapp, sms,
      // whatsapp) still only ever produces 2 attempts — the third slot repeats a
      // channel already attempted and `nextChannel` skips it.
      expect(attempts).toHaveLength(2);
      expect(attempts.map((a) => a.channel)).toEqual(["whatsapp", "sms"]);
    } finally {
      await worker.close();
    }
  });

  // G8: the applicable rate is looked up and frozen onto the attempt at send time.
  it("writes cost_micros_at_send from provider_rates onto a successful attempt", async () => {
    await insertProviderRate(infra.pg, {
      id: "rate_test_whatsapp_in",
      provider: "meta",
      channel: "whatsapp",
      country: "IN",
      messageType: "authentication",
      rateMicros: 115_000,
      currency: "INR",
      effectiveFrom: new Date("2026-07-01T00:00:00Z"),
    });

    const provider = new SimulatedProvider({ latencyMs: 0 });
    const worker = new Worker<DeliveryJobData>(
      DELIVERY_QUEUE_NAME,
      createDeliveryProcessor({
        pg: infra.pg,
        provider,
        logger,
        deadLetterQueue: queues.deadLetterQueue,
        deliveryQueue: queues.deliveryQueue,
        fallbackQueue: queues.fallbackQueue,
        keys,
      }),
      { connection: bullConnection },
    );

    try {
      const startRes = await app.inject({
        method: "POST",
        url: "/v1/verification/start",
        headers: { authorization: `Bearer ${apiKey}` },
        payload: { phone_number: "+919876543210" },
      });
      const { verification_id: verificationId } = startRes.json();

      await waitFor(async () => {
        const [attempt] = await infra.pg`
          SELECT status FROM delivery_attempts WHERE verification_id = ${verificationId}
        `;
        return attempt?.status === "sent";
      });

      const [attempt] = await infra.pg`
        SELECT cost_micros_at_send FROM delivery_attempts WHERE verification_id = ${verificationId}
      `;
      expect(Number(attempt?.cost_micros_at_send)).toBe(115_000);
    } finally {
      await worker.close();
    }
  });
});

/** Always takes `latencyMs` to answer — used to prove /start never waits on it. */
class SlowProvider implements Provider {
  constructor(private readonly latencyMs: number) {}

  async send(params: SendParams): Promise<SendResult> {
    await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    return { providerMessageId: `slow_${params.code}` };
  }

  // Not exercised by this test double — only `send()` is under test here.
  verifySignature = (): boolean => false;
  parseWebhook = (): readonly never[] => [];
  mapErrorCode = (): ProviderError["code"] => "provider_error";
}

/** First call hangs forever (models a crash mid-send); every call after that succeeds. */
class HangOnceProvider implements Provider {
  callCount = 0;
  readonly completedSends: SendParams[] = [];

  // Not exercised by this test double — only `send()` is under test here.
  verifySignature = (): boolean => false;
  parseWebhook = (): readonly never[] => [];
  mapErrorCode = (): ProviderError["code"] => "provider_error";

  async send(params: SendParams): Promise<SendResult> {
    this.callCount += 1;
    if (this.callCount === 1) {
      // Never resolves — the "worker" that made this call is about to be killed.
      return new Promise<SendResult>(() => {});
    }
    this.completedSends.push(params);
    return { providerMessageId: `resumed_${params.code}` };
  }
}
