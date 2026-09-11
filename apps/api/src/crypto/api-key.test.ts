import { describe, expect, it } from "vitest";
import { apiKeyPrefix, generateApiKey, hashApiKey, verifyApiKey } from "./api-key.js";

describe("api keys", () => {
  it("extracts the same prefix that was generated", () => {
    const { fullKey, prefix } = generateApiKey("test");
    expect(apiKeyPrefix(fullKey)).toBe(prefix);
    expect(prefix.startsWith("sk_test_")).toBe(true);
  });

  it("hashes and verifies with argon2", async () => {
    const { fullKey } = generateApiKey("test");
    const hash = await hashApiKey(fullKey, "pepper");
    expect(await verifyApiKey(fullKey, "pepper", hash)).toBe(true);
    expect(await verifyApiKey("sk_test_wrong.key", "pepper", hash)).toBe(false);
  });

  it("rejects the right key under the wrong pepper", async () => {
    const { fullKey } = generateApiKey("test");
    const hash = await hashApiKey(fullKey, "pepper-a");
    expect(await verifyApiKey(fullKey, "pepper-b", hash)).toBe(false);
  });
});
