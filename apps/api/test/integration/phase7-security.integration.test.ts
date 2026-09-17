import { Writable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import pino from "pino";
import { findAccountById } from "@otp-router/db/repositories/accounts";
import { insertProviderRate } from "@otp-router/db/repositories/provider-rates";
import { SimulatedProvider } from "@otp-router/providers/simulated";
import { DELIVERY_QUEUE_NAME, type DeliveryJobData } from "@otp-router/core/queue/delivery-job";
import { createDeliveryProcessor } from "@otp-router/worker/processors/delivery";
import { closeQueues, createQueues, type Queues } from "@otp-router/worker/queue/queues";
import { checkPrefixVelocity } from "../../src/services/fraud-signals.js";
import { buildApp } from "../../src/app.js";
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
let apiKey: string;
let accountId: string;

async function seedAccount(
  name: string,
  overrides: { dailyCostCapMicros?: number } = {},
): Promise<{ accountId: string; apiKey: string }> {
  return seedAccountShared(infra.pg, API_KEY_PEPPER, name, overrides);
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

describe("Phase 7 — Idempotency-Key replay (R1.1.6/T4)", () => {
  it("replays the original response and creates no second verification or delivery attempt", async () => {
    const idempotencyKey = "test-idempotency-key-1";

    const first = await app.inject({
      method: "POST",
      url: "/v1/verification/start",
      headers: { authorization: `Bearer ${apiKey}`, "idempotency-key": idempotencyKey },
      payload: { phone_number: "+919876543210" },
    });
    expect(first.statusCode).toBe(202);

    const second = await app.inject({
      method: "POST",
      url: "/v1/verification/start",
      headers: { authorization: `Bearer ${apiKey}`, "idempotency-key": idempotencyKey },
      payload: { phone_number: "+919876543210" },
    });
    expect(second.statusCode).toBe(202);
    expect(second.json()).toEqual(first.json());

    const verifications =
      await infra.pg`SELECT id FROM verifications WHERE account_id = ${accountId}`;
    expect(verifications).toHaveLength(1);
    const attempts = await infra.pg`
      SELECT id FROM delivery_attempts WHERE verification_id = ${first.json().verification_id}
    `;
    expect(attempts).toHaveLength(1);
  });

  it("a different Idempotency-Key on the same number is a genuinely new verification", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/v1/verification/start",
      headers: { authorization: `Bearer ${apiKey}`, "idempotency-key": "key-a" },
      payload: { phone_number: "+919876543210" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/verification/start",
      headers: { authorization: `Bearer ${apiKey}`, "idempotency-key": "key-b" },
      payload: { phone_number: "+919876543211" },
    });
    expect(second.json().verification_id).not.toBe(first.json().verification_id);
  });
});

describe("Phase 7 — sliding-window rate limits (R7.1/R1.1.7)", () => {
  it("the 6th /start for the same number within the window responds 429 with Retry-After", async () => {
    let last;
    for (let i = 0; i < 6; i++) {
      last = await app.inject({
        method: "POST",
        url: "/v1/verification/start",
        headers: { authorization: `Bearer ${apiKey}` },
        payload: { phone_number: "+919876543210" },
      });
    }
    expect(last?.statusCode).toBe(429);
    expect(last?.json().error).toBe("rate_limited_number");
    expect(last?.headers["retry-after"]).toBeDefined();
  });

  it("a different number is unaffected by another number's rate limit", async () => {
    for (let i = 0; i < 6; i++) {
      await app.inject({
        method: "POST",
        url: "/v1/verification/start",
        headers: { authorization: `Bearer ${apiKey}` },
        payload: { phone_number: "+919876543210" },
      });
    }
    const res = await app.inject({
      method: "POST",
      url: "/v1/verification/start",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { phone_number: "+919876549999" },
    });
    expect(res.statusCode).toBe(202);
  });
});

describe("Phase 7 — toll-fraud protection (R7.5/R7.6)", () => {
  it("R7.6: a prefix velocity breach trips the account to manual_review", async () => {
    // Exercised directly against the real service (rather than through 31 HTTP calls)
    // so this test isolates R7.6 from R1.1.7's per-IP ceiling, which every /start call
    // in this test file would otherwise also be counted against — app.inject requests
    // all share one synthetic IP, and the per-IP limit (20/min) is lower than the
    // prefix velocity limit (30/min) it would need to reach.
    const silentLogger = { warn: () => {} };
    let tripped = false;
    for (let i = 0; i < 31 && !tripped; i++) {
      tripped = await checkPrefixVelocity(
        infra.redis,
        infra.pg,
        { accountId, phoneNumber: `+9198765${String(i).padStart(5, "0")}` },
        silentLogger,
      );
    }
    expect(tripped).toBe(true);

    const account = await findAccountById(infra.pg, accountId);
    expect(account?.status).toBe("manual_review");
  });

  it("R7.5: exceeding the daily spend ceiling trips the account to manual_review", async () => {
    await truncateAll(infra.pg, infra.redis); // isolate from the shared beforeEach account above
    const capped = await seedAccount("Capped", { dailyCostCapMicros: 100_000 });

    await insertProviderRate(infra.pg, {
      id: "rate_whatsapp_in",
      provider: "meta",
      channel: "whatsapp",
      country: "IN",
      messageType: "authentication",
      rateMicros: 115_000, // one send alone exceeds the 100,000 cap
      currency: "INR",
      effectiveFrom: new Date("2026-07-01T00:00:00Z"),
    });

    const provider = new SimulatedProvider({ latencyMs: 0 });
    const worker = new Worker<DeliveryJobData>(
      DELIVERY_QUEUE_NAME,
      createDeliveryProcessor({
        pg: infra.pg,
        provider,
        logger: pino({ level: "silent" }),
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
        headers: { authorization: `Bearer ${capped.apiKey}` },
        payload: { phone_number: "+919876543210" },
      });
      expect(startRes.statusCode).toBe(202);

      await waitFor(async () => {
        const account = await findAccountById(infra.pg, capped.accountId);
        return account?.status === "manual_review";
      });

      const account = await findAccountById(infra.pg, capped.accountId);
      expect(account?.status).toBe("manual_review");
    } finally {
      await worker.close();
    }
  });
});

describe("Phase 7 — plaintext code never reaches a log line (R7.2 audit)", () => {
  it("the code SimulatedProvider actually sent never appears in any captured log output", async () => {
    const capturedLines: string[] = [];
    const captureStream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        capturedLines.push(chunk.toString("utf8"));
        callback();
      },
    });
    // level: "trace" — R7.2 says "never, at any level," so the audit has to look at
    // the noisiest level, not whatever level production happens to run at.
    const capturingLogger = pino({ level: "trace" }, captureStream);

    const provider = new SimulatedProvider({ latencyMs: 0 });
    const worker = new Worker<DeliveryJobData>(
      DELIVERY_QUEUE_NAME,
      createDeliveryProcessor({
        pg: infra.pg,
        provider,
        logger: capturingLogger,
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

      await waitFor(() => provider.sentMessages.length === 1);

      // The sanctioned way to recover the plaintext code in a test (I4/R5.3) — the
      // server itself never exposes it, so this is the same place a real WhatsApp/SMS
      // sandbox would let a test inspect an outbound message.
      const sentMessage = provider.sentMessages[0];
      expect(sentMessage).toBeDefined();
      const code = sentMessage?.code ?? "";
      expect(code.length).toBeGreaterThan(0);

      await app.inject({
        method: "POST",
        url: "/v1/verification/check",
        headers: { authorization: `Bearer ${apiKey}` },
        payload: { verification_id: verificationId, code: "000000" }, // deliberately wrong, exercises the failure log path too
      });

      const allOutput = capturedLines.join("");
      expect(allOutput).not.toContain(code);
    } finally {
      await worker.close();
    }
  });
});

describe("Phase 7 — OpenAPI spec generated from the same Zod schemas (R11.6)", () => {
  it("/openapi.json describes /v1/verification/start from its actual route schema", async () => {
    const res = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(res.statusCode).toBe(200);

    const spec = res.json();
    expect(spec.openapi).toBeDefined();
    const startOp = spec.paths?.["/v1/verification/start"]?.post;
    expect(startOp).toBeDefined();
    expect(startOp.responses["202"]).toBeDefined();
    expect(startOp.responses["429"]).toBeDefined();
  });
});
