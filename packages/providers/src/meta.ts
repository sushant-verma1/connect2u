import { createHmac, timingSafeEqual } from "node:crypto";
import {
  isRecord,
  type Channel,
  type ParsedWebhookEvent,
  type Provider,
  type ProviderError,
  type SendParams,
  type SendResult,
} from "./provider.js";

export class MetaProviderError extends Error {
  constructor(
    public readonly code: ProviderError["code"],
    message: string,
    /** Meta's own numeric `error.code` (e.g. 131026) — kept alongside the mapped
     * taxonomy code so a failure is diagnosable from logs without guessing which raw
     * code a given mapped code came from. Undefined for non-HTTP failures. */
    public readonly rawCode?: number,
    /** Meta's `error.error_data.details` — a human-readable explanation of what was
     * malformed. Generic codes like 100 are undiagnosable from `rawCode` alone; this
     * is the field that actually says which parameter was wrong. */
    public readonly errorDetails?: string,
  ) {
    super(message);
  }
}

export type MetaProviderOptions = Readonly<{
  phoneNumberId: string;
  accessToken: string;
  /** R6.1: the WhatsApp app secret `X-Hub-Signature-256` is computed against. */
  appSecret: string;
  /** Defaults to the template proven live in Phase 4's `hello_world` send — see README. */
  templateName?: string;
  templateLanguageCode?: string;
  apiVersion?: string;
  /**
   * Sends a free-form session message (Meta's 24h customer service window) instead of
   * an authentication template. Not the production pattern — production OTP is
   * business-initiated and requires a template, which requires business verification
   * (see README). Off by default; the recipient must have messaged the business
   * number within the last 24h or the send fails with `session_window_closed`.
   */
  allowSessionMessages?: boolean;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}>;

/** I4: strips a code from a provider-supplied error message before it's ever stored —
 * `MetaProviderError.message` is Meta's own `error.message`, which the worker copies
 * into dead-letter records, so this is the boundary that keeps a session-message send
 * failure from leaking the code Meta echoed back. */
function redactCode(message: string, code: string): string {
  if (!code) return message;
  return message.split(code).join("[redacted]");
}

// Meta Cloud API error codes worth distinguishing (see Meta's WhatsApp Cloud API error
// reference). Everything else falls back to `provider_error` — the conservative,
// retryable default.
const META_ERROR_CODE_MAP: ReadonlyMap<number, ProviderError["code"]> = new Map([
  // 100 is Meta's generic OAuthException "invalid parameter" — it covers a malformed
  // `to`, but just as often a malformed template/text payload, an unset field, or a
  // credentials/phone_number_id problem. Nothing about the recipient specifically, so
  // it must not map to invalid_number — that would poison G3's per-number capability
  // score with a fact about our request, not about the recipient. `errorDetails`
  // (Meta's `error_data.details`) is what actually says which parameter was wrong.
  [100, "provider_error"],
  [131009, "invalid_number"], // parameter value is not valid.
  [131026, "not_on_channel"], // message undeliverable — recipient not reachable on WhatsApp.
  [131047, "session_window_closed"], // re-engagement message outside the 24h customer service window.
  [131031, "blocked"], // account restricted for policy violations.
  [368, "blocked"], // account restricted.
  [131056, "rate_limited"], // pair rate limit hit.
  [80007, "rate_limited"], // WABA-level rate limit hit.
]);

export function mapMetaErrorCode(err: unknown): ProviderError["code"] {
  if (err instanceof MetaProviderError) {
    return err.code;
  }
  return "provider_error";
}

function classifyMetaErrorCode(code: number | undefined): ProviderError["code"] {
  if (code === undefined) return "provider_error";
  return META_ERROR_CODE_MAP.get(code) ?? "provider_error";
}

/**
 * R6.1: constant-time compare against `sha256=` + HMAC-SHA256(rawBody, appSecret) — the
 * signature is only meaningful when checked against the exact bytes Meta signed, before
 * any JSON parsing touches them.
 */
export function verifyMetaSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  if (!signatureHeader?.startsWith("sha256=")) {
    return false;
  }
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const provided = signatureHeader.slice("sha256=".length);
  const expectedBuf = Buffer.from(expected, "hex");
  const providedBuf = Buffer.from(provided, "hex");
  return expectedBuf.length === providedBuf.length && timingSafeEqual(expectedBuf, providedBuf);
}

/** R6.3/R6.5: flattens every `statuses[]` entry across every `entry`/`changes` — Meta
 * batches multiple status updates (possibly for different messages) into one webhook
 * call. Unrecognised `status` values pass through as-is; the ingest processor is what
 * decides which event types it acts on versus no-ops. Narrows the untrusted payload one
 * property at a time rather than asserting its shape — anything malformed is silently
 * skipped, never thrown (R6.5). */
export function parseMetaStatusWebhook(body: unknown): readonly ParsedWebhookEvent[] {
  const events: ParsedWebhookEvent[] = [];
  if (!isRecord(body) || !Array.isArray(body.entry)) {
    return events;
  }
  for (const entry of body.entry) {
    if (!isRecord(entry) || !Array.isArray(entry.changes)) continue;
    for (const change of entry.changes) {
      if (!isRecord(change) || !isRecord(change.value) || !Array.isArray(change.value.statuses)) {
        continue;
      }
      for (const status of change.value.statuses) {
        if (
          !isRecord(status) ||
          typeof status.id !== "string" ||
          typeof status.status !== "string"
        ) {
          continue;
        }
        events.push({ providerMessageId: status.id, eventType: status.status, payload: status });
      }
    }
  }
  return events;
}

/** R5.4: the adapter proving the real Cloud API contract (PROJECT.md's hard constraint —
 * authentication templates are unavailable on a test WABA, so this sends `hello_world`
 * for the recorded live proof; `SimulatedProvider` remains the primary delivery path). */
export class MetaProvider implements Provider {
  private readonly phoneNumberId: string;
  private readonly accessToken: string;
  private readonly appSecret: string;
  private readonly templateName: string;
  private readonly templateLanguageCode: string;
  private readonly apiVersion: string;
  private readonly allowSessionMessages: boolean;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MetaProviderOptions) {
    this.phoneNumberId = options.phoneNumberId;
    this.accessToken = options.accessToken;
    this.appSecret = options.appSecret;
    this.templateName = options.templateName ?? "hello_world";
    this.templateLanguageCode = options.templateLanguageCode ?? "en_US";
    this.apiVersion = options.apiVersion ?? "v20.0";
    this.allowSessionMessages = options.allowSessionMessages ?? false;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async send(params: SendParams): Promise<SendResult> {
    if (params.channel !== ("whatsapp" satisfies Channel)) {
      throw new MetaProviderError(
        "not_on_channel",
        `MetaProvider only sends whatsapp, got ${params.channel}`,
      );
    }

    // README's "WhatsApp session messages (demo only)": allowSessionMessages trades the
    // authentication template for a free-form text send inside Meta's 24h customer
    // service window. Not the production path — kept behind an explicit flag so it's
    // never reachable by accident.
    const messagePayload = this.allowSessionMessages
      ? { type: "text" as const, text: { body: params.code } }
      : {
          type: "template" as const,
          template: { name: this.templateName, language: { code: this.templateLanguageCode } },
        };

    const url = `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`;
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: params.phoneNumber.replace(/^\+/, ""),
        ...messagePayload,
      }),
    });

    const body: unknown = await response.json();
    const json = isRecord(body) ? body : {};
    const error = isRecord(json.error) ? json.error : undefined;

    if (!response.ok) {
      const rawCode = typeof error?.code === "number" ? error.code : undefined;
      const errorData = isRecord(error?.error_data) ? error.error_data : undefined;
      const rawDetails = typeof errorData?.details === "string" ? errorData.details : undefined;
      const rawMessage =
        typeof error?.message === "string"
          ? error.message
          : `Meta send failed with HTTP ${response.status}`;
      throw new MetaProviderError(
        classifyMetaErrorCode(rawCode),
        // I4: never let the code we just sent end up embedded in a stored error message.
        redactCode(rawMessage, params.code),
        rawCode,
        rawDetails ? redactCode(rawDetails, params.code) : undefined,
      );
    }

    const firstMessage = Array.isArray(json.messages) ? json.messages[0] : undefined;
    const messageId =
      isRecord(firstMessage) && typeof firstMessage.id === "string" ? firstMessage.id : undefined;
    if (!messageId) {
      throw new MetaProviderError("provider_error", "Meta response carried no message id");
    }
    return { providerMessageId: messageId };
  }

  verifySignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
    return verifyMetaSignature(rawBody, signatureHeader, this.appSecret);
  }

  parseWebhook(body: unknown): readonly ParsedWebhookEvent[] {
    return parseMetaStatusWebhook(body);
  }

  mapErrorCode(err: unknown): ProviderError["code"] {
    return mapMetaErrorCode(err);
  }
}
