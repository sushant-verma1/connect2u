// Shared contract between apps/api (producer) and apps/worker (consumer). Types only —
// no I/O — so both sides can depend on it without violating the core dependency rule.

export const DELIVERY_QUEUE_NAME = "delivery";
export const DELIVERY_DLQ_NAME = "delivery-dead-letter";

export type DeliveryJobData = Readonly<{
  attemptId: string;
  verificationId: string;
  accountId: string;
  phoneNumber: string;
  code: string;
  channel: "whatsapp" | "sms";
  correlationId: string;
  // R4.5: the timeout the routing pipeline computed for this channel at /start time
  // (or that advanceOrFail re-read from the verification row on fallback) — never a
  // global constant. See apps/worker/src/processors/delivery.ts.
  timeoutMs: number;
}>;

// Sanitised record for the dead-letter inspection endpoint — deliberately excludes
// `code` and `phoneNumber`, the two sensitive fields on DeliveryJobData (I4/R7.3).
export type DeadLetterRecord = Readonly<{
  attemptId: string;
  verificationId: string;
  accountId: string;
  channel: string;
  errorCode: string;
  errorMessage: string;
  attemptsMade: number;
  failedAt: string;
  correlationId: string;
}>;
