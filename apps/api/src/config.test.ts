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
});
