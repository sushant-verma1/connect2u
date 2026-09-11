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
});
