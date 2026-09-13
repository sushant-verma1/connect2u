import { createDecipheriv } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

/**
 * Decrypts a value produced by apps/api's `encryptPhone`/`encryptCode`
 * (base64(iv || authTag || ciphertext), AES-256-GCM). The worker only ever decrypts —
 * for fallback redelivery of the phone number and code (R2.3) — it never encrypts, so
 * there's no matching `encryptString` here.
 */
export function decryptString(encrypted: string, keyBase64: string): string {
  const key = Buffer.from(keyBase64, "base64");
  const payload = Buffer.from(encrypted, "base64");
  const iv = payload.subarray(0, IV_LENGTH);
  const authTag = payload.subarray(IV_LENGTH, IV_LENGTH + 16);
  const ciphertext = payload.subarray(IV_LENGTH + 16);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
