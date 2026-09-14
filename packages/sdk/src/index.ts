// Typed client for POST /v1/verification/start and /check (G9). Field names mirror
// the wire format exactly (apps/api/src/routes/verification.ts) — no camelCase
// translation layer for a handful of fields nobody's confused by.

export type Channel = "whatsapp" | "sms";
export type VerificationStatus = "pending" | "verified" | "expired" | "burned" | "failed";
export type CheckOutcome =
  | "verified"
  | "invalid_code"
  | "expired"
  | "already_verified"
  | "attempts_exceeded"
  | "not_found"
  | "failed";

export type StartParams = {
  phone_number: string;
  channels?: Channel[];
  locale?: string;
  code_length?: number;
  ttl_seconds?: number;
  metadata?: Record<string, unknown>;
  /** R1.1.6: auto-generated with crypto.randomUUID() when omitted — a retried
   * network call should replay the original send, not queue a second one. */
  idempotency_key?: string;
};

export type StartResult = {
  verification_id: string;
  status: "pending";
  channel_attempted: Channel;
  expires_at: string;
};

export type CheckParams = {
  verification_id: string;
  code: string;
};

export type CheckResult = {
  verification_id: string;
  status: CheckOutcome;
  /** null on a verified verification with no attributable attempt — never defaulted. */
  channel_verified?: string | null;
  attempts_used?: number;
  metadata?: Record<string, unknown>;
};

export type GetResult = {
  verification_id: string;
  status: VerificationStatus;
  expires_at: string;
  attempts_used: number;
  max_attempts: number;
  channel_verified?: string | null;
  metadata?: Record<string, unknown>;
};

export class OtpRouterApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(`otp-router API error (${status}): ${code}`);
  }
}

export type OtpRouterClientOptions = {
  apiKey: string;
  baseUrl?: string;
};

export class OtpRouterClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: OtpRouterClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://api.otp-router.example").replace(/\/$/, "");
  }

  async start(params: StartParams): Promise<StartResult> {
    const { idempotency_key, ...body } = params;
    return this.request<StartResult>("POST", "/v1/verification/start", body, {
      "Idempotency-Key": idempotency_key ?? crypto.randomUUID(),
    });
  }

  async check(params: CheckParams): Promise<CheckResult> {
    return this.request<CheckResult>("POST", "/v1/verification/check", params);
  }

  async get(verificationId: string): Promise<GetResult> {
    return this.request<GetResult>("GET", `/v1/verification/${encodeURIComponent(verificationId)}`);
  }

  /** Polls GET until the verification leaves `pending`, or `timeoutMs` elapses. */
  async waitForResult(
    verificationId: string,
    options: { intervalMs?: number; timeoutMs?: number } = {},
  ): Promise<GetResult> {
    const intervalMs = options.intervalMs ?? 2000;
    const timeoutMs = options.timeoutMs ?? 120_000;
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const result = await this.get(verificationId);
      if (result.status !== "pending") return result;
      if (Date.now() >= deadline) {
        throw new Error(`waitForResult: ${verificationId} still pending after ${timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...extraHeaders,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const code =
        json !== null &&
        typeof json === "object" &&
        "error" in json &&
        typeof json.error === "string"
          ? json.error
          : res.statusText;
      throw new OtpRouterApiError(res.status, code);
    }
    return json;
  }
}
