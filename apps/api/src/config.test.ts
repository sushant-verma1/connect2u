import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const validEnv = {
  NODE_ENV: "test",
  PORT: "3000",
  LOG_LEVEL: "debug",
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/otp_router",
  REDIS_URL: "redis://localhost:6379",
  OTP_PEPPER: "otp-pepper",
  PHONE_HASH_PEPPER: "phone-pepper",
  API_KEY_PEPPER: "api-key-pepper",
  PASSWORD_PEPPER: "password-pepper",
  PHONE_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  CODE_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString("base64"),
};

describe("loadConfig", () => {
  it("parses a complete environment", () => {
    const config = loadConfig(validEnv);
    expect(config.port).toBe(3000);
    expect(config.databaseUrl).toBe(validEnv.DATABASE_URL);
  });

  it("fails fast when a required var is missing (R11.3)", () => {
    const { OTP_PEPPER, ...withoutOtpPepper } = validEnv;
    expect(() => loadConfig(withoutOtpPepper)).toThrow(/OTP_PEPPER/);
  });

  it("fails fast when DATABASE_URL is missing", () => {
    const { DATABASE_URL, ...withoutDatabaseUrl } = validEnv;
    expect(() => loadConfig(withoutDatabaseUrl)).toThrow(/DATABASE_URL/);
  });

  it("fails fast when PASSWORD_PEPPER is missing (R13.6)", () => {
    const { PASSWORD_PEPPER, ...withoutPasswordPepper } = validEnv;
    expect(() => loadConfig(withoutPasswordPepper)).toThrow(/PASSWORD_PEPPER/);
  });

  it("fails fast when PHONE_ENCRYPTION_KEY is not 32 bytes", () => {
    const badEnv = { ...validEnv, PHONE_ENCRYPTION_KEY: Buffer.alloc(16).toString("base64") };
    expect(() => loadConfig(badEnv)).toThrow(/PHONE_ENCRYPTION_KEY/);
  });

  it("fails fast when CODE_ENCRYPTION_KEY is not 32 bytes", () => {
    const badEnv = { ...validEnv, CODE_ENCRYPTION_KEY: Buffer.alloc(16).toString("base64") };
    expect(() => loadConfig(badEnv)).toThrow(/CODE_ENCRYPTION_KEY/);
  });
});
