import { describe, expect, it } from "vitest";
import { outcomeForTerminalStatus } from "./check-outcome.js";

describe("outcomeForTerminalStatus", () => {
  it("maps verified to already_verified", () => {
    expect(outcomeForTerminalStatus("verified")).toBe("already_verified");
  });
  it("maps expired to expired", () => {
    expect(outcomeForTerminalStatus("expired")).toBe("expired");
  });
  it("maps burned to attempts_exceeded", () => {
    expect(outcomeForTerminalStatus("burned")).toBe("attempts_exceeded");
  });
  it("maps failed to failed", () => {
    expect(outcomeForTerminalStatus("failed")).toBe("failed");
  });
});
