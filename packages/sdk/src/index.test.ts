import { afterEach, describe, expect, it, vi } from "vitest";
import { OtpRouterApiError, OtpRouterClient } from "./index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetch(status: number, body: unknown) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

function idempotencyKeyFrom(spy: ReturnType<typeof mockFetch>): string | null {
  const call = spy.mock.calls[0];
  const init = call?.[1];
  return new Headers(init?.headers).get("Idempotency-Key");
}

describe("OtpRouterClient", () => {
  it("start() sends an auto-generated Idempotency-Key when none is given", async () => {
    const fetchMock = mockFetch(202, {
      verification_id: "ver_1",
      status: "pending",
      channel_attempted: "whatsapp",
      expires_at: "2026-01-01T00:00:00Z",
    });
    const client = new OtpRouterClient({ apiKey: "sk_test", baseUrl: "https://example.com" });

    const result = await client.start({ phone_number: "+919876543210" });

    expect(result.verification_id).toBe("ver_1");
    expect(idempotencyKeyFrom(fetchMock)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("start() reuses a caller-supplied Idempotency-Key", async () => {
    const fetchMock = mockFetch(202, {
      verification_id: "ver_1",
      status: "pending",
      channel_attempted: "sms",
      expires_at: "2026-01-01T00:00:00Z",
    });
    const client = new OtpRouterClient({ apiKey: "sk_test", baseUrl: "https://example.com" });

    await client.start({ phone_number: "+919876543210", idempotency_key: "my-key" });

    expect(idempotencyKeyFrom(fetchMock)).toBe("my-key");
  });

  it("throws OtpRouterApiError with the response's error code on failure", async () => {
    mockFetch(422, { error: "invalid_phone_number" });
    const client = new OtpRouterClient({ apiKey: "sk_test", baseUrl: "https://example.com" });

    await expect(client.start({ phone_number: "bad" })).rejects.toMatchObject(
      new OtpRouterApiError(422, "invalid_phone_number"),
    );
  });

  it("waitForResult() polls until the verification leaves pending", async () => {
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls += 1;
      const status = calls < 3 ? "pending" : "verified";
      return new Response(
        JSON.stringify({
          verification_id: "ver_1",
          status,
          expires_at: "2026-01-01T00:00:00Z",
          attempts_used: 1,
          max_attempts: 5,
        }),
        { status: 200 },
      );
    });

    const client = new OtpRouterClient({ apiKey: "sk_test", baseUrl: "https://example.com" });
    const result = await client.waitForResult("ver_1", { intervalMs: 1 });

    expect(result.status).toBe("verified");
    expect(calls).toBe(3);
  });
});
