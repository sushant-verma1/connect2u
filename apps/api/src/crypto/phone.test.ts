import { describe, expect, it } from "vitest";
import { normalizePhoneNumber } from "./phone.js";

describe("normalizePhoneNumber", () => {
  it("normalises a valid Indian number to E.164", () => {
    expect(normalizePhoneNumber("+91 98765 43210")).toBe("+919876543210");
  });

  it("returns null for an invalid number", () => {
    expect(normalizePhoneNumber("not-a-phone-number")).toBeNull();
    expect(normalizePhoneNumber("123")).toBeNull();
  });
});
