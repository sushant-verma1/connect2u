import { describe, expect, it } from "vitest";
import { SimulatedProvider, SimulatedProviderError } from "./simulated.js";

describe("SimulatedProvider", () => {
  it("exposes every attempted send via sentMessages — the sanctioned way to read a code in tests (I4)", async () => {
    const provider = new SimulatedProvider({ latencyMs: 0 });
    await provider.send({ phoneNumber: "+919876543210", code: "483920", channel: "whatsapp" });

    expect(provider.sentMessages).toHaveLength(1);
    expect(provider.sentMessages[0]).toEqual({
      phoneNumber: "+919876543210",
      code: "483920",
      channel: "whatsapp",
    });
  });

  it("records a send attempt even when it goes on to fail", async () => {
    const provider = new SimulatedProvider({ latencyMs: 0, failureRate: 1 });
    await expect(
      provider.send({ phoneNumber: "+919876543210", code: "111111", channel: "whatsapp" }),
    ).rejects.toBeInstanceOf(SimulatedProviderError);

    expect(provider.sentMessages).toHaveLength(1);
    expect(provider.sentMessages[0]?.code).toBe("111111");
  });
});
