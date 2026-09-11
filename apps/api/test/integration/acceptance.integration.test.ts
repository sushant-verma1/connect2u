import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { insertAccount } from "@otp-router/db/repositories/accounts";
import { insertVerification } from "@otp-router/db/repositories/verifications";
import { buildApp } from "../../src/app.js";
import { generateApiKey, hashApiKey } from "../../src/crypto/api-key.js";
import { hmacHex } from "../../src/crypto/hmac.js";
import { encryptPhone } from "../../src/crypto/phone-encryption.js";
import { startInfra, truncateAll, type Infra } from "./harness.js";

const OTP_PEPPER = "test-otp-pepper";
const PHONE_HASH_PEPPER = "test-phone-hash-pepper";
const API_KEY_PEPPER = "test-api-key-pepper";
const PHONE_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");

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
};

let infra: Infra;
let app: FastifyInstance;
let accountId: string;
let apiKey: string;
let otherApiKey: string;

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
  await app.close();
  await infra.stop();
});

beforeEach(async () => {
  await truncateAll(infra.pg);
  ({ accountId, apiKey } = await seedAccount("Acme"));
  ({ apiKey: otherApiKey } = await seedAccount("Other"));
  app = await buildApp(config, infra.pg, infra.redis);
});

describe("verification lifecycle acceptance tests", () => {
  // T2: full happy path against real Postgres + Redis.
  it("T2 — start then check with the correct code succeeds", async () => {
    const startRes = await app.inject({
      method: "POST",
      url: "/v1/verification/start",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { phone_number: "+919876543210", code_length: 4 },
    });
    expect(startRes.statusCode).toBe(202);
    const { verification_id: verificationId } = startRes.json();

    const record = await infra.pg`
      SELECT code_hmac FROM verifications WHERE id = ${verificationId}
    `;
    const row = record[0];
    if (!row) {
      throw new Error("verification row not found");
    }
    const codeHmac: string = row.code_hmac;
    // The plaintext code never leaves the server (I4) — recover it only for this test's
    // own assertion by brute-forcing the tiny fixed space, not by reading it back.
    let code = "";
    for (let candidate = 0; candidate < 10_000; candidate++) {
      const attempt = candidate.toString().padStart(4, "0");
      if (hmacHex(attempt, OTP_PEPPER) === codeHmac) {
        code = attempt;
        break;
      }
    }
    expect(code).not.toBe("");

    const checkRes = await app.inject({
      method: "POST",
      url: "/v1/verification/check",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { verification_id: verificationId, code },
    });
    expect(checkRes.statusCode).toBe(200);
    expect(checkRes.json().status).toBe("verified");
  });

  // T3: expiry path and attempt-exhaustion path.
  it("T3 — an expired verification cannot be checked", async () => {
    const verification = await insertVerification(infra.pg, {
      id: "ver_expired",
      accountId,
      phoneHash: hmacHex("+919876543210", PHONE_HASH_PEPPER),
      phoneEncrypted: encryptPhone("+919876543210", PHONE_ENCRYPTION_KEY),
      codeHmac: hmacHex("111111", OTP_PEPPER),
      expiresAt: new Date(Date.now() - 1000),
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/verification/check",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { verification_id: verification.id, code: "111111" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("expired");
  });

  it("T3 — the 5th wrong attempt burns the code permanently", async () => {
    const verification = await insertVerification(infra.pg, {
      id: "ver_burn",
      accountId,
      phoneHash: hmacHex("+919876543210", PHONE_HASH_PEPPER),
      phoneEncrypted: encryptPhone("+919876543210", PHONE_ENCRYPTION_KEY),
      codeHmac: hmacHex("111111", OTP_PEPPER),
      expiresAt: new Date(Date.now() + 300_000),
    });

    let lastStatus: string | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/verification/check",
        headers: { authorization: `Bearer ${apiKey}` },
        payload: { verification_id: verification.id, code: "000000" },
      });
      lastStatus = res.json().status;
    }

    expect(lastStatus).toBe("attempts_exceeded");

    // The code was correct all along — burned means burned, even against the right code.
    const afterBurn = await app.inject({
      method: "POST",
      url: "/v1/verification/check",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { verification_id: verification.id, code: "111111" },
    });
    expect(afterBurn.json().status).toBe("attempts_exceeded");
  });

  // T9: cross-tenant read attempt denied.
  it("T9 — an account cannot read another account's verification", async () => {
    const verification = await insertVerification(infra.pg, {
      id: "ver_cross_tenant",
      accountId,
      phoneHash: hmacHex("+919876543210", PHONE_HASH_PEPPER),
      phoneEncrypted: encryptPhone("+919876543210", PHONE_ENCRYPTION_KEY),
      codeHmac: hmacHex("111111", OTP_PEPPER),
      expiresAt: new Date(Date.now() + 300_000),
    });

    const res = await app.inject({
      method: "GET",
      url: `/v1/verification/${verification.id}`,
      headers: { authorization: `Bearer ${otherApiKey}` },
    });
    expect(res.statusCode).toBe(404);

    // Sanity: the owning account can read it.
    const ownRes = await app.inject({
      method: "GET",
      url: `/v1/verification/${verification.id}`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(ownRes.statusCode).toBe(200);
  });

  // T1 — the non-negotiable one. 50 concurrent /check calls with the correct code,
  // against real Postgres, exactly one succeeds. AGENTS.md §5: a concurrency test that
  // passes once may be passing by luck — run the race 20 independent times, each
  // against its own freshly inserted row, all in the same real Postgres instance.
  const T1_ROUNDS = 20;
  for (let round = 1; round <= T1_ROUNDS; round++) {
    it(`T1 — 50 concurrent correct checks yield exactly one verified (round ${round}/${T1_ROUNDS})`, async () => {
      const verification = await insertVerification(infra.pg, {
        id: `ver_race_${round}`,
        accountId,
        phoneHash: hmacHex("+919876543210", PHONE_HASH_PEPPER),
        phoneEncrypted: encryptPhone("+919876543210", PHONE_ENCRYPTION_KEY),
        codeHmac: hmacHex("654321", OTP_PEPPER),
        expiresAt: new Date(Date.now() + 300_000),
      });

      const requests = Array.from({ length: 50 }, () =>
        app.inject({
          method: "POST",
          url: "/v1/verification/check",
          headers: { authorization: `Bearer ${apiKey}` },
          payload: { verification_id: verification.id, code: "654321" },
        }),
      );
      const responses = await Promise.all(requests);
      const statuses: string[] = responses.map((res) => res.json().status);

      const verifiedCount = statuses.filter((status) => status === "verified").length;
      const alreadyVerifiedCount = statuses.filter(
        (status) => status === "already_verified",
      ).length;

      expect(verifiedCount).toBe(1);
      expect(alreadyVerifiedCount).toBe(49);
    });
  }
});
