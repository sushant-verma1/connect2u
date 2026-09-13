import type { Job, Queue } from "bullmq";
import type { Logger } from "pino";
import { ulid } from "ulid";
import type { PgClient } from "@otp-router/db/client";
import {
  findDeliveryAttemptByProviderMessageId,
  markDeliveryAttemptDelivered,
  markDeliveryAttemptFailedFromSent,
} from "@otp-router/db/repositories/delivery-attempts";
import { insertWebhookEventIfNew } from "@otp-router/db/repositories/webhook-events";
import type { DeliveryJobData } from "@otp-router/core/queue/delivery-job";
import { fallbackTimerJobId, type FallbackTimerJobData } from "@otp-router/core/queue/fallback-job";
import type { WebhookIngestJobData } from "@otp-router/core/queue/webhook-job";
import { advanceOrFail, type FallbackKeys } from "../services/fallback.js";
import { updateCapabilityForOutcome } from "../services/capability.js";

/**
 * R6.2/T6: dedupe is the `webhook_events` unique index, not this code — a duplicate
 * (provider, provider_message_id, event_type) insert returns `null` and processing
 * stops there, which is the entire "duplicate webhook causes exactly one state
 * transition" guarantee. R6.5: unknown message IDs log and no-op, never throw.
 */
export function createWebhookIngestProcessor(
  pg: PgClient,
  deliveryQueue: Queue<DeliveryJobData>,
  fallbackQueue: Queue<FallbackTimerJobData>,
  keys: FallbackKeys,
  logger: Logger,
) {
  return async function processWebhookIngest(job: Job<WebhookIngestJobData>): Promise<void> {
    const { provider, providerMessageId, eventType, payload, correlationId, signatureValid } =
      job.data;
    const log = logger.child({ correlationId, providerMessageId, eventType });

    const inserted = await insertWebhookEventIfNew(pg, {
      id: `whe_${ulid()}`,
      provider,
      providerMessageId,
      eventType,
      payloadJson: payload,
      signatureValid,
    });
    if (!inserted) {
      log.info("duplicate webhook event — no-op");
      return;
    }

    const attempt = await findDeliveryAttemptByProviderMessageId(pg, providerMessageId);
    if (!attempt) {
      log.warn("webhook event for unknown provider_message_id — no-op");
      return;
    }

    if (eventType === "delivered") {
      // T7/T8: this only succeeds if the attempt is still `sent` — if the fallback
      // timer already won the race and moved it to `timed_out`, this is a no-op
      // (R4.8: a late delivery confirmation never un-does an already-fired fallback).
      const delivered = await markDeliveryAttemptDelivered(pg, { id: attempt.id });
      if (delivered) {
        await fallbackQueue.remove(fallbackTimerJobId(attempt.id));
        // R3.6: the channel actually delivered for this number — a success signal.
        await updateCapabilityForOutcome(
          pg,
          {
            verificationId: attempt.verificationId,
            accountId: attempt.accountId,
            channel: attempt.channel,
          },
          "success",
          new Date(),
        );
      }
      return;
    }

    if (eventType === "failed") {
      // R4.4 trigger #2: a delivery-failed webhook.
      const failed = await markDeliveryAttemptFailedFromSent(pg, {
        id: attempt.id,
        errorCode: "delivery_failed",
      });
      if (!failed) {
        log.info("delivery-failed webhook against an already-resolved attempt — no-op");
        return;
      }

      await fallbackQueue.remove(fallbackTimerJobId(attempt.id));
      // R3.6: the channel reported a delivery failure for this number.
      await updateCapabilityForOutcome(
        pg,
        {
          verificationId: attempt.verificationId,
          accountId: attempt.accountId,
          channel: attempt.channel,
        },
        "failure",
        new Date(),
      );
      await advanceOrFail(pg, deliveryQueue, keys, {
        verificationId: attempt.verificationId,
        accountId: attempt.accountId,
        correlationId,
      });
      return;
    }

    // R6.5: event types this system doesn't act on (Meta's "sent"/"read") log and
    // no-op rather than being mistaken for a failure — only "delivered" and "failed"
    // drive fallback.
    log.info({ eventType }, "webhook event type is not actionable — no-op");
  };
}
