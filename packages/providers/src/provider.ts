// R5.1: the common interface every channel adapter implements. Zero I/O here — this is
// a type-only contract; each adapter does its own I/O.
export type Channel = "whatsapp" | "sms";

export type SendResult = Readonly<{
  providerMessageId: string;
}>;

export type SendParams = Readonly<{
  phoneNumber: string;
  code: string;
  channel: Channel;
}>;

// R5.1/R6: what a provider's webhook payload resolves to, independent of that
// provider's wire format — the one shape the ingest queue/processor deal in.
export type ParsedWebhookEvent = Readonly<{
  providerMessageId: string;
  eventType: string;
  payload: Record<string, unknown>;
}>;

// R5.6: the shared error taxonomy every adapter maps its failures onto.
export const PROVIDER_ERROR_CODES = [
  "invalid_number",
  "not_on_channel",
  "rate_limited",
  "provider_error",
  "blocked",
  // Meta's 24h customer service window is closed — only reachable when
  // META_ALLOW_SESSION_MESSAGES is set (see MetaProvider/README). Distinct from
  // not_on_channel: this says nothing about whether the recipient has WhatsApp.
  "session_window_closed",
] as const;

export type ProviderError = Readonly<{
  code: (typeof PROVIDER_ERROR_CODES)[number];
  message: string;
}>;

// R5.1: the common interface every channel adapter implements — send plus everything a
// webhook route needs to turn that provider's inbound payload into the one shape the
// rest of the system deals in, without the route knowing which provider it's talking to.
export interface Provider {
  send(params: SendParams): Promise<SendResult>;
  /** R6.1: verified against the raw request body, before any parsing. */
  verifySignature(rawBody: Buffer, signatureHeader: string | undefined): boolean;
  parseWebhook(body: unknown): readonly ParsedWebhookEvent[];
  mapErrorCode(err: unknown): ProviderError["code"];
}

// R5.6: which taxonomy codes are worth retrying. A wrong number or a blocked recipient
// will never succeed on retry; a rate limit or a transient provider error might. A
// closed session window won't reopen inside a job's retry backoff either.
const PERMANENT_ERROR_CODES: ReadonlySet<ProviderError["code"]> = new Set([
  "invalid_number",
  "not_on_channel",
  "blocked",
  "session_window_closed",
]);

export function isPermanentError(code: ProviderError["code"]): boolean {
  return PERMANENT_ERROR_CODES.has(code);
}

const PROVIDER_ERROR_CODE_SET: ReadonlySet<string> = new Set(PROVIDER_ERROR_CODES);

function isProviderErrorCode(code: string): code is ProviderError["code"] {
  return PROVIDER_ERROR_CODE_SET.has(code);
}

function hasCodeProperty(value: unknown): value is { code: unknown } {
  return typeof value === "object" && value !== null && "code" in value;
}

/** Narrows an `unknown` webhook payload one property at a time, no type assertions. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Every adapter's failures are expected to carry a `code` from the shared taxonomy
 * (structural, not `instanceof`, so any adapter's error class qualifies). Unrecognised
 * shapes classify as `provider_error` — transient — the conservative default.
 */
export function providerErrorCode(err: unknown): ProviderError["code"] {
  if (hasCodeProperty(err) && typeof err.code === "string" && isProviderErrorCode(err.code)) {
    return err.code;
  }
  return "provider_error";
}

/** The provider's own raw error code (e.g. Meta's numeric `error.code`), structurally
 * read off whatever adapter threw — so a mapped code like `invalid_number` is
 * diagnosable in logs without guessing which raw code produced it. */
export function providerRawCode(err: unknown): number | undefined {
  if (
    typeof err === "object" &&
    err !== null &&
    "rawCode" in err &&
    typeof err.rawCode === "number"
  ) {
    return err.rawCode;
  }
  return undefined;
}

/** The provider's own explanation of what was malformed (e.g. Meta's
 * `error.error_data.details`) — generic codes like Meta's 100 are undiagnosable from
 * `rawCode` alone without this. */
export function providerErrorDetails(err: unknown): string | undefined {
  if (
    typeof err === "object" &&
    err !== null &&
    "errorDetails" in err &&
    typeof err.errorDetails === "string"
  ) {
    return err.errorDetails;
  }
  return undefined;
}
