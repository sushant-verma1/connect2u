import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password.js";

describe("passwords", () => {
  it("hashes and verifies with argon2", async () => {
    const hash = await hashPassword("correct horse battery staple", "pepper");
    expect(await verifyPassword("correct horse battery staple", "pepper", hash)).toBe(true);
    expect(await verifyPassword("wrong password", "pepper", hash)).toBe(false);
  });

  it("rejects the right password under the wrong pepper", async () => {
    const hash = await hashPassword("correct horse battery staple", "pepper-a");
    expect(await verifyPassword("correct horse battery staple", "pepper-b", hash)).toBe(false);
  });
});
