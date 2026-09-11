import { randomBytes } from "node:crypto";
import argon2 from "argon2";

const PREFIX_BYTE_LENGTH = 4; // 8 hex chars
const SECRET_BYTE_LENGTH = 32;

export type GeneratedApiKey = Readonly<{
  fullKey: string;
  prefix: string;
}>;

/** R7.4: a non-secret prefix identifies the key so lookup never needs to scan+argon2 every row. */
export function generateApiKey(env: "test" | "live"): GeneratedApiKey {
  const prefix = `sk_${env}_${randomBytes(PREFIX_BYTE_LENGTH).toString("hex")}`;
  const secret = randomBytes(SECRET_BYTE_LENGTH).toString("base64url");
  return { fullKey: `${prefix}.${secret}`, prefix };
}

export function apiKeyPrefix(fullKey: string): string | null {
  const separatorIndex = fullKey.indexOf(".");
  return separatorIndex === -1 ? null : fullKey.slice(0, separatorIndex);
}

/** R7.4: argon2 for API keys — never for OTP codes. Pepper adds entropy beyond the key itself. */
export async function hashApiKey(fullKey: string, pepper: string): Promise<string> {
  return argon2.hash(fullKey + pepper);
}

export async function verifyApiKey(
  fullKey: string,
  pepper: string,
  storedHash: string,
): Promise<boolean> {
  return argon2.verify(storedHash, fullKey + pepper);
}
