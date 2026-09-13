import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptCode, encryptCode } from "./code-encryption.js";

describe("code encryption", () => {
  const key = randomBytes(32).toString("base64");

  it("round-trips a code", () => {
    const encrypted = encryptCode("483920", key);
    expect(encrypted).not.toContain("483920");
    expect(decryptCode(encrypted, key)).toBe("483920");
  });

  it("fails to decrypt with the wrong key", () => {
    const encrypted = encryptCode("483920", key);
    const wrongKey = randomBytes(32).toString("base64");
    expect(() => decryptCode(encrypted, wrongKey)).toThrow();
  });
});
