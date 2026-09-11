import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptPhone, encryptPhone } from "./phone-encryption.js";

describe("phone encryption", () => {
  const key = randomBytes(32).toString("base64");

  it("round-trips a phone number", () => {
    const encrypted = encryptPhone("+919876543210", key);
    expect(encrypted).not.toContain("9876543210");
    expect(decryptPhone(encrypted, key)).toBe("+919876543210");
  });

  it("fails to decrypt with the wrong key", () => {
    const encrypted = encryptPhone("+919876543210", key);
    const wrongKey = randomBytes(32).toString("base64");
    expect(() => decryptPhone(encrypted, wrongKey)).toThrow();
  });

  it("uses a fresh nonce every call, stored alongside the ciphertext", () => {
    const IV_LENGTH = 12;
    const encryptions = Array.from({ length: 50 }, () => encryptPhone("+919876543210", key));

    // Different ciphertext every time (GCM: same key+nonce+plaintext would repeat exactly).
    expect(new Set(encryptions).size).toBe(encryptions.length);

    // The leading IV_LENGTH bytes (the nonce) are never repeated across calls, and each
    // still decrypts correctly using the nonce it carries — proving it round-trips from
    // storage rather than being derived from the key.
    const nonces = encryptions.map((value) => Buffer.from(value, "base64").subarray(0, IV_LENGTH));
    const uniqueNonces = new Set(nonces.map((nonce) => nonce.toString("hex")));
    expect(uniqueNonces.size).toBe(encryptions.length);

    for (const encrypted of encryptions) {
      expect(decryptPhone(encrypted, key)).toBe("+919876543210");
    }
  });
});
