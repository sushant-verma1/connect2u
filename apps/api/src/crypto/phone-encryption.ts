import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

/**
 * R7.3: the active verification record is the one place the real phone number is
 * recoverable at rest. AES-256-GCM, distinct key from the HMAC peppers and from
 * `CODE_ENCRYPTION_KEY` (I1-adjacent — reversible encryption and one-way hashing must
 * never share key material, and neither should two unrelated reversible fields).
 * Stored as base64(iv || authTag || ciphertext).
 */
export function encryptPhone(e164: string, keyBase64: string): string {
  const key = Buffer.from(keyBase64, "base64");
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(e164, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

export function decryptPhone(encrypted: string, keyBase64: string): string {
  const key = Buffer.from(keyBase64, "base64");
  const payload = Buffer.from(encrypted, "base64");
  const iv = payload.subarray(0, IV_LENGTH);
  const authTag = payload.subarray(IV_LENGTH, IV_LENGTH + 16);
  const ciphertext = payload.subarray(IV_LENGTH + 16);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
