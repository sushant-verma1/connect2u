import { describe, expect, it } from "vitest";
import { hmacHex, hmacMatches } from "./hmac.js";

describe("hmacMatches", () => {
  it("matches the same value under the same pepper", () => {
    const hash = hmacHex("483920", "pepper-a");
    expect(hmacMatches("483920", "pepper-a", hash)).toBe(true);
  });

  it("rejects a different value", () => {
    const hash = hmacHex("483920", "pepper-a");
    expect(hmacMatches("000000", "pepper-a", hash)).toBe(false);
  });

  it("rejects the same value under a different pepper", () => {
    const hash = hmacHex("483920", "pepper-a");
    expect(hmacMatches("483920", "pepper-b", hash)).toBe(false);
  });

  it("rejects malformed stored hashes without throwing", () => {
    expect(hmacMatches("483920", "pepper-a", "not-hex")).toBe(false);
  });
});
