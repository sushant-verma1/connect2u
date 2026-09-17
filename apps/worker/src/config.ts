import { z } from "zod";

const base64Aes256Key = () =>
  z
    .string()
    .min(1)
    .refine((value) => Buffer.from(value, "base64").length === 32, {
      message: "must be base64 encoding exactly 32 bytes (AES-256)",
    });

/** R11.3: fails at boot on any missing required env var, mirroring apps/api's config. */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  // Bull Board — dev only (ARCHITECTURE.md §2).
  WORKER_PORT: z.coerce.number().int().positive().default(3001),
  // R2.3/R4: the worker decrypts these to redeliver the exact same code and phone
  // number to the next channel in the fallback chain — never regenerated.
  PHONE_ENCRYPTION_KEY: base64Aes256Key(),
  CODE_ENCRYPTION_KEY: base64Aes256Key(),

  // Mirrors apps/api's Meta config — all optional, since the worker falls back to
  // SimulatedProvider for whatsapp whenever any of these is missing.
  META_PHONE_NUMBER_ID: z.string().optional(),
  META_ACCESS_TOKEN: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  // Off by default, on purpose (README "WhatsApp session messages (demo only)"): sends
  // the code as a free-form text message inside Meta's 24h customer service window
  // instead of an authentication template. Not the production pattern — enum rather
  // than z.coerce.boolean() so a typo'd value fails loudly at boot instead of silently
  // coercing to `true`.
  META_ALLOW_SESSION_MESSAGES: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

export type Config = Readonly<{
  nodeEnv: "development" | "test" | "production";
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  databaseUrl: string;
  redisUrl: string;
  workerPort: number;
  phoneEncryptionKey: string;
  codeEncryptionKey: string;
  metaPhoneNumberId?: string;
  metaAccessToken?: string;
  metaAppSecret?: string;
  metaAllowSessionMessages: boolean;
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
    logLevel: data.LOG_LEVEL,
    databaseUrl: data.DATABASE_URL,
    redisUrl: data.REDIS_URL,
    workerPort: data.WORKER_PORT,
    phoneEncryptionKey: data.PHONE_ENCRYPTION_KEY,
    codeEncryptionKey: data.CODE_ENCRYPTION_KEY,
    metaPhoneNumberId: data.META_PHONE_NUMBER_ID,
    metaAccessToken: data.META_ACCESS_TOKEN,
    metaAppSecret: data.META_APP_SECRET,
    metaAllowSessionMessages: data.META_ALLOW_SESSION_MESSAGES,
  };
}
