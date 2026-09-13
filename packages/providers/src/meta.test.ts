import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
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

  it("maps a Meta error response onto the shared taxonomy via mapErrorCode", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(400, { error: { message: "Invalid parameter", code: 100 } }));
    const provider = new MetaProvider({
      phoneNumberId: "123",
      accessToken: "token",
      appSecret: APP_SECRET,
      fetchImpl,
    });

    const err = await provider
      .send({ phoneNumber: "+91bad", code: "123456", channel: "whatsapp" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MetaProviderError);
    expect(provider.mapErrorCode(err)).toBe("invalid_number");
  });
});
