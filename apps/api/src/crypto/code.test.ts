import { describe, expect, it } from "vitest";
import { generateCode } from "./code.js";

describe("generateCode", () => {
  it("produces a zero-padded numeric string of the requested length", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateCode(6);
      expect(code).toMatch(/^\d{6}$/);
    }
  });

  it("supports other lengths", () => {
    expect(generateCode(4)).toMatch(/^\d{4}$/);
    expect(generateCode(8)).toMatch(/^\d{8}$/);
  });
});
