import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import {
  DELIVERY_DLQ_NAME,
  DELIVERY_QUEUE_NAME,
  type DeadLetterRecord,
  type DeliveryJobData,
} from "@otp-router/core/queue/delivery-job";
import {
  FALLBACK_TIMER_QUEUE_NAME,
  type FallbackTimerJobData,
} from "@otp-router/core/queue/fallback-job";
import {
  WEBHOOK_INGEST_QUEUE_NAME,
  type WebhookIngestJobData,
} from "@otp-router/core/queue/webhook-job";

const RETRY_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 1000;

export type Queues = Readonly<{
  deliveryQueue: Queue<DeliveryJobData>;
  deadLetterQueue: Queue<DeadLetterRecord>;
  fallbackQueue: Queue<FallbackTimerJobData>;
  webhookIngestQueue: Queue<WebhookIngestJobData>;
}>;

/**
 * ARCHITECTURE.md §6: transient errors retry with backoff+jitter (bullmq's built-in
 * jitter, not hand-rolled). Permanent errors are thrown from the worker as
 * `UnrecoverableError`, which bullmq fails immediately regardless of `attempts`.
 */
export function createQueues(connection: Redis): Queues {
  return {
    deliveryQueue: new Queue<DeliveryJobData>(DELIVERY_QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        attempts: RETRY_ATTEMPTS,
        backoff: { type: "exponential", delay: BASE_BACKOFF_MS, jitter: 0.5 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    }),
    // Dead-letter jobs are never processed — the queue is used purely as an
    // inspectable list.
    deadLetterQueue: new Queue<DeadLetterRecord>(DELIVERY_DLQ_NAME, { connection }),
    // The API only ever removes jobs from this queue (best-effort cancellation on
    // verify success) — it's the worker that schedules and processes them.
    fallbackQueue: new Queue<FallbackTimerJobData>(FALLBACK_TIMER_QUEUE_NAME, { connection }),
    webhookIngestQueue: new Queue<WebhookIngestJobData>(WEBHOOK_INGEST_QUEUE_NAME, {
      connection,
      defaultJobOptions: { removeOnComplete: true, removeOnFail: true },
    }),
  };
}

export async function closeQueues(queues: Queues): Promise<void> {
  await Promise.all([
    queues.deliveryQueue.close(),
    queues.deadLetterQueue.close(),
    queues.fallbackQueue.close(),
    queues.webhookIngestQueue.close(),
  ]);
}
