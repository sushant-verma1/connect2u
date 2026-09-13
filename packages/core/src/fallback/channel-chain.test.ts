import { describe, expect, it } from "vitest";
import {
  buildChannelChain,
  DEFAULT_CHANNEL_CHAIN,
  isChannel,
  MAX_FALLBACK_CHANNELS,
  nextChannel,
  type Channel,
} from "./channel-chain.js";

describe("buildChannelChain", () => {
  it("falls back to the default chain when no channels are requested", () => {
    expect(buildChannelChain(undefined)).toEqual(DEFAULT_CHANNEL_CHAIN);
    expect(buildChannelChain([])).toEqual(DEFAULT_CHANNEL_CHAIN);
  });

  it("uses the requested order verbatim", () => {
    expect(buildChannelChain(["sms", "whatsapp"])).toEqual(["sms", "whatsapp"]);
  });

  it("caps the chain at MAX_FALLBACK_CHANNELS (R4.7)", () => {
    const oversized: Channel[] = Array.from({ length: MAX_FALLBACK_CHANNELS + 5 }, (_, i) =>
      i % 2 === 0 ? "whatsapp" : "sms",
    );
    expect(buildChannelChain(oversized)).toHaveLength(MAX_FALLBACK_CHANNELS);
  });
});

describe("nextChannel", () => {
  it("returns the first unattempted channel in chain order", () => {
    expect(nextChannel(["whatsapp", "sms"], [])).toBe("whatsapp");
    expect(nextChannel(["whatsapp", "sms"], ["whatsapp"])).toBe("sms");
  });

  it("returns null once every channel in the chain has been attempted", () => {
    expect(nextChannel(["whatsapp", "sms"], ["whatsapp", "sms"])).toBeNull();
  });

  it("ignores attempted channels outside the chain", () => {
    expect(nextChannel(["whatsapp", "sms"], ["email"])).toBe("whatsapp");
  });
});

describe("isChannel", () => {
  it("accepts known channels and rejects everything else", () => {
    expect(isChannel("whatsapp")).toBe(true);
    expect(isChannel("sms")).toBe(true);
    expect(isChannel("email")).toBe(false);
  });
});
