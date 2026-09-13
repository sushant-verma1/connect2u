import { describe, expect, it } from "vitest";
import { classifyCountry } from "./country.js";

describe("classifyCountry", () => {
  it("classifies an Indian E.164 number as IN", () => {
    expect(classifyCountry("+919876543210")).toBe("IN");
  });

  it("classifies every other E.164 number as INTL", () => {
    expect(classifyCountry("+14155552671")).toBe("INTL");
    expect(classifyCountry("+447911123456")).toBe("INTL");
  });
});
