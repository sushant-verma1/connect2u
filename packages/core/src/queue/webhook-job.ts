export const WEBHOOK_INGEST_QUEUE_NAME = "webhook-ingest";

// "delivered"/"failed" are the two that drive fallback (R4.4). Real providers report
// more (Meta also sends "sent"/"read") — R6.5: those log and no-op in the processor
// rather than being rejected here.
export type WebhookEventType = string;

export type WebhookIngestJobData = Readonly<{
  provider: string;
  providerMessageId: string;
  eventType: WebhookEventType;
  payload: Record<string, unknown>;
  correlationId: string;
  // R6.6: persisted alongside the raw payload. `null` for providers with no signature
  // scheme (`SimulatedProvider`); `true` for a real provider — the route only ever
  // reaches the queue after `verifySignature` already passed (R6.1).
  signatureValid: boolean | null;
}>;
