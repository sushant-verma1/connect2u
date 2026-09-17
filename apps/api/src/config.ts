import { z } from "zod";

const base64Aes256Key = () =>
  z
    .string()
    .min(1)
    .refine((value) => Buffer.from(value, "base64").length === 32, {
      message: "must be base64 encoding exactly 32 bytes (AES-256)",
    });

/**
 * R11.3: fails at boot on any missing required env var. Meta/Twilio/demo vars are
 * optional here because nothing reads them before Phase 4 — required-but-unused
 * config would break local dev for no benefit.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  PORT: z.coerce.number().int().positive(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  // AGENTS.md §11: separate peppers, never shared between purposes. PASSWORD_PEPPER
  // is R13.6's fourth — dashboard passwords are argon2 like API keys (same primitive,
  // R7.4) but must not reuse API_KEY_PEPPER's pepper.
  OTP_PEPPER: z.string().min(1),
  PHONE_HASH_PEPPER: z.string().min(1),
  API_KEY_PEPPER: z.string().min(1),
  PASSWORD_PEPPER: z.string().min(1),

  // AES-256-GCM key for `verifications.phone_encrypted` (R7.3: the active verification
  // record is the one place the real number is recoverable). Not one of the three HMAC
  // peppers — reversible encryption is a different primitive and must not share key
  // material with one-way hashing.
  PHONE_ENCRYPTION_KEY: base64Aes256Key(),

  // AES-256-GCM key for `verifications.code_encrypted` (R2.3: one code, shared across
  // every channel, never regenerated on fallback — this is what lets a later channel in
  // the chain resend the exact same code). Distinct key from PHONE_ENCRYPTION_KEY.
  CODE_ENCRYPTION_KEY: base64Aes256Key(),

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

  // Phase 8: the dashboard is a separate origin (Vite dev server) reading this API
  // directly (ARCHITECTURE.md — no BFF), so it needs an explicit CORS allowance.
  // Defaults to Vite's own default port rather than a wildcard. R13.7: also the origin
  // Google redirects the browser back to — the dashboard proxies `/v1/*` through to
  // this API (nginx.conf.template/vite.config.ts), so the redirect_uri registered in
  // Google Cloud Console is this origin, never the API's own — reused rather than a
  // second "public origin" var that would just have to be kept equal to this one.
  DASHBOARD_ORIGIN: z.string().url().default("http://localhost:5173"),

  // F1 (auth-audit): which peers may set X-Forwarded-For — the per-IP rate limits are
  // only per-IP if this matches the real topology. Default covers every way this API is
  // actually reached: `loopback` for the same-host Vite proxy in dev, `uniquelocal`
  // (10/8, 172.16/12, 192.168/16, fc00::/7) for a docker bridge or Railway's internal
  // IPv6 network. Public source addresses are deliberately absent — a client reaching
  // this API directly is not a proxy and its X-Forwarded-For is ignored. Override with
  // a comma-separated list of CIDRs/presets if the proxy sits outside those ranges.
  TRUST_PROXY: z.string().min(1).default("loopback,uniquelocal"),

  // R13.7: optional — like Meta's credentials, "Sign in with Google" only registers
  // its routes once both are set (app.ts), so local dev without a Google Cloud project
  // isn't blocked from booting.
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
});

export type Config = Readonly<{
  nodeEnv: "development" | "test" | "production";
  port: number;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  databaseUrl: string;
  redisUrl: string;
  otpPepper: string;
  phoneHashPepper: string;
  apiKeyPepper: string;
  passwordPepper: string;
  phoneEncryptionKey: string;
  codeEncryptionKey: string;
  metaPhoneNumberId?: string;
  metaAccessToken?: string;
  metaAppSecret?: string;
  metaWebhookVerifyToken?: string;
  metaTemplateName?: string;
  dashboardOrigin: string;
  trustProxy: string;
  googleClientId?: string;
  googleClientSecret?: string;
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
    passwordPepper: data.PASSWORD_PEPPER,
    phoneEncryptionKey: data.PHONE_ENCRYPTION_KEY,
    codeEncryptionKey: data.CODE_ENCRYPTION_KEY,
    metaPhoneNumberId: data.META_PHONE_NUMBER_ID,
    metaAccessToken: data.META_ACCESS_TOKEN,
    metaAppSecret: data.META_APP_SECRET,
    metaWebhookVerifyToken: data.META_WEBHOOK_VERIFY_TOKEN,
    metaTemplateName: data.META_TEMPLATE_NAME,
    dashboardOrigin: data.DASHBOARD_ORIGIN,
    trustProxy: data.TRUST_PROXY,
    googleClientId: data.GOOGLE_CLIENT_ID,
    googleClientSecret: data.GOOGLE_CLIENT_SECRET,
  };
}
