import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { isPermanentError } from "./provider.js";
import {
  MetaProvider,
  MetaProviderError,
  parseMetaStatusWebhook,
  verifyMetaSignature,
} from "./meta.js";

const APP_SECRET = "test-app-secret";

function signatureFor(body: string): string {
  return `sha256=${createHmac("sha256", APP_SECRET).update(body).digest("hex")}`;
}

describe("verifyMetaSignature", () => {
  it("accepts a signature computed over the exact raw body", () => {
    const body = Buffer.from(JSON.stringify({ hello: "world" }));
    expect(verifyMetaSignature(body, signatureFor(body.toString()), APP_SECRET)).toBe(true);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const body = Buffer.from(JSON.stringify({ hello: "world" }));
    const wrongSignature = `sha256=${createHmac("sha256", "wrong-secret").update(body).digest("hex")}`;
    expect(verifyMetaSignature(body, wrongSignature, APP_SECRET)).toBe(false);
  });

  it("rejects a missing or malformed header", () => {
    const body = Buffer.from("{}");
    expect(verifyMetaSignature(body, undefined, APP_SECRET)).toBe(false);
    expect(verifyMetaSignature(body, "not-a-signature", APP_SECRET)).toBe(false);
  });

  it("rejects a body that was modified after the signature was computed", () => {
    const original = Buffer.from(JSON.stringify({ hello: "world" }));
    const tampered = Buffer.from(JSON.stringify({ hello: "mallory" }));
    expect(verifyMetaSignature(tampered, signatureFor(original.toString()), APP_SECRET)).toBe(
      false,
    );
  });
});

describe("parseMetaStatusWebhook", () => {
  it("flattens every status across every entry/changes batch", () => {
    const body = {
      entry: [
        {
          changes: [
            { value: { statuses: [{ id: "wamid.1", status: "delivered" }] } },
            { value: { statuses: [{ id: "wamid.2", status: "failed" }] } },
          ],
        },
      ],
    };
    expect(parseMetaStatusWebhook(body)).toEqual([
      {
        providerMessageId: "wamid.1",
        eventType: "delivered",
        payload: { id: "wamid.1", status: "delivered" },
      },
      {
        providerMessageId: "wamid.2",
        eventType: "failed",
        payload: { id: "wamid.2", status: "failed" },
      },
    ]);
  });

  it("returns an empty list for a payload with no statuses", () => {
    expect(parseMetaStatusWebhook({})).toEqual([]);
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("MetaProvider.send", () => {
  it("posts a template message and returns the provider message id", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { messages: [{ id: "wamid.abc" }] }));
    const provider = new MetaProvider({
      phoneNumberId: "123",
      accessToken: "token",
      appSecret: APP_SECRET,
      fetchImpl,
    });

    const result = await provider.send({
      phoneNumber: "+919876543210",
      code: "123456",
      channel: "whatsapp",
    });

    expect(result).toEqual({ providerMessageId: "wamid.abc" });
    const call = fetchImpl.mock.calls[0];
    if (!call) throw new Error("fetchImpl was never called");
    const [url, init] = call;
    expect(url).toContain("/123/messages");
    expect(typeof init?.body).toBe("string");
    expect(JSON.parse(typeof init?.body === "string" ? init.body : "{}")).toMatchObject({
      to: "919876543210",
      type: "template",
    });
  });

  // The DB stores phone numbers in E.164 (leading `+`); Meta's Cloud API rejects a `to`
  // that still has one (131026/invalid_number) — this only surfaces against the live
  // API, so it needs its own assertion rather than riding along inside another test.
  it("strips the leading + from an E.164 number before it reaches Meta's `to` field", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { messages: [{ id: "wamid.abc" }] }));
    const provider = new MetaProvider({
      phoneNumberId: "123",
      accessToken: "token",
      appSecret: APP_SECRET,
      fetchImpl,
    });

    await provider.send({ phoneNumber: "+14155552671", code: "123456", channel: "whatsapp" });

    const call = fetchImpl.mock.calls[0];
    if (!call) throw new Error("fetchImpl was never called");
    const [, init] = call;
    const sentBody: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    expect(sentBody).toMatchObject({ to: "14155552671" });
    if (
      sentBody === null ||
      typeof sentBody !== "object" ||
      !("to" in sentBody) ||
      typeof sentBody.to !== "string"
    ) {
      throw new Error("expected sentBody.to to be a string");
    }
    expect(sentBody.to.startsWith("+")).toBe(false);
  });

  it("maps a Meta error response onto the shared taxonomy via mapErrorCode", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(400, { error: { message: "Parameter value is not valid", code: 131009 } }),
      );
    const provider = new MetaProvider({
      phoneNumberId: "123",
      accessToken: "token",
      appSecret: APP_SECRET,
      fetchImpl,
    });

    const err = await provider
      .send({ phoneNumber: "+91bad", code: "123456", channel: "whatsapp" })
      .catch((e: unknown) => e);

    if (!(err instanceof MetaProviderError)) {
      throw new Error("expected a MetaProviderError");
    }
    expect(provider.mapErrorCode(err)).toBe("invalid_number");
    // The raw numeric code must survive alongside the mapped one, or a live failure
    // like 131026 is only diagnosable by guessing which raw code produced it.
    expect(err.rawCode).toBe(131009);
  });

  // Code 100 is Meta's generic "invalid parameter" — it says nothing about the
  // recipient, so it must not land on invalid_number (that would poison the
  // per-number capability score with a fact about our request, not theirs). It falls
  // back to provider_error, the same conservative default as any unrecognised code.
  it("maps Meta's generic invalid-parameter error (100) to provider_error, not invalid_number", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(400, {
        error: {
          message: "Invalid parameter",
          code: 100,
          error_data: { details: "Param text['body'] is required." },
        },
      }),
    );
    const provider = new MetaProvider({
      phoneNumberId: "123",
      accessToken: "token",
      appSecret: APP_SECRET,
      allowSessionMessages: true,
      fetchImpl,
    });

    const err = await provider
      .send({ phoneNumber: "+919876543210", code: "123456", channel: "whatsapp" })
      .catch((e: unknown) => e);

    if (!(err instanceof MetaProviderError)) {
      throw new Error("expected a MetaProviderError");
    }
    expect(provider.mapErrorCode(err)).toBe("provider_error");
    expect(err.rawCode).toBe(100);
    // error_data.details is what actually says which parameter was wrong — a 100 is
    // undiagnosable from rawCode alone without it.
    expect(err.errorDetails).toBe("Param text['body'] is required.");
  });

  it("sends a template body when allowSessionMessages is unset (the default)", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { messages: [{ id: "wamid.abc" }] }));
    const provider = new MetaProvider({
      phoneNumberId: "123",
      accessToken: "token",
      appSecret: APP_SECRET,
      fetchImpl,
    });

    await provider.send({ phoneNumber: "+919876543210", code: "123456", channel: "whatsapp" });

    const call = fetchImpl.mock.calls[0];
    if (!call) throw new Error("fetchImpl was never called");
    const [, init] = call;
    const sentBody: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    expect(sentBody).toMatchObject({ type: "template" });
    expect(sentBody).not.toHaveProperty("text");
  });

  it("sends a free-form text body carrying the code when allowSessionMessages is true", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { messages: [{ id: "wamid.abc" }] }));
    const provider = new MetaProvider({
      phoneNumberId: "123",
      accessToken: "token",
      appSecret: APP_SECRET,
      allowSessionMessages: true,
      fetchImpl,
    });

    await provider.send({ phoneNumber: "+919876543210", code: "123456", channel: "whatsapp" });

    const call = fetchImpl.mock.calls[0];
    if (!call) throw new Error("fetchImpl was never called");
    const [, init] = call;
    const sentBody: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    expect(sentBody).toMatchObject({ type: "text", text: { body: "123456" } });
    expect(sentBody).not.toHaveProperty("template");
  });

  it("maps error 131047 (outside the 24h window) onto session_window_closed, and it's permanent", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(400, {
        error: { message: "Re-engagement message outside the allowed window", code: 131047 },
      }),
    );
    const provider = new MetaProvider({
      phoneNumberId: "123",
      accessToken: "token",
      appSecret: APP_SECRET,
      allowSessionMessages: true,
      fetchImpl,
    });

    const err = await provider
      .send({ phoneNumber: "+919876543210", code: "123456", channel: "whatsapp" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MetaProviderError);
    const code = provider.mapErrorCode(err);
    expect(code).toBe("session_window_closed");
    expect(isPermanentError(code)).toBe(true);
  });

  // I4: the code just sent must never survive into a stored error message, even if
  // Meta's own response happens to echo it back.
  it("redacts the code from a Meta error message that echoes it", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(400, { error: { message: "code 654321 rejected", code: 100 } }),
      );
    const provider = new MetaProvider({
      phoneNumberId: "123",
      accessToken: "token",
      appSecret: APP_SECRET,
      allowSessionMessages: true,
      fetchImpl,
    });

    const err: unknown = await provider
      .send({ phoneNumber: "+919876543210", code: "654321", channel: "whatsapp" })
      .catch((e: unknown) => e);

    if (!(err instanceof MetaProviderError)) {
      throw new Error("expected a MetaProviderError");
    }
    expect(err.message).not.toContain("654321");
  });
});
