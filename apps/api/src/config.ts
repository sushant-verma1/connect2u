import { z } from "zod";

/**
 * R11.3: fails at boot on any missing required env var. Meta/Twilio/demo vars are
 * optional here because nothing reads them before Phase 4 — required-but-unused
 * config would break local dev for no benefit.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  PORT: z.coerce.number().int().positive(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  // Three separate peppers (ARCHITECTURE.md §9) — never shared between purposes.
  OTP_PEPPER: z.string().min(1),
  PHONE_HASH_PEPPER: z.string().min(1),
  API_KEY_PEPPER: z.string().min(1),

  META_PHONE_NUMBER_ID: z.string().optional(),
  META_WABA_ID: z.string().optional(),
  META_ACCESS_TOKEN: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_WEBHOOK_VERIFY_TOKEN: z.string().optional(),
  META_TEMPLATE_NAME: z.string().optional(),

  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM_NUMBER: z.string().optional(),

  DEMO_RECIPIENT_NUMBER: z.string().optional(),
});

export type Config = Readonly<{
  nodeEnv: "development" | "test" | "production";
  port: number;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
  databaseUrl: string;
  redisUrl: string;
  otpPepper: string;
  phoneHashPepper: string;
  apiKeyPepper: string;
}>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid configuration — refusing to boot: ${issues}`);
  }

  const data = parsed.data;
  return {
    nodeEnv: data.NODE_ENV,
    port: data.PORT,
    logLevel: data.LOG_LEVEL,
    databaseUrl: data.DATABASE_URL,
    redisUrl: data.REDIS_URL,
    otpPepper: data.OTP_PEPPER,
    phoneHashPepper: data.PHONE_HASH_PEPPER,
    apiKeyPepper: data.API_KEY_PEPPER,
  };
}
