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
import {
  SCORE_RECOMPUTE_QUEUE_NAME,
  type ScoreRecomputeJobData,
} from "@otp-router/core/queue/score-recompute-job";

export type Queues = Readonly<{
  deliveryQueue: Queue<DeliveryJobData>;
  deadLetterQueue: Queue<DeadLetterRecord>;
  fallbackQueue: Queue<FallbackTimerJobData>;
  webhookIngestQueue: Queue<WebhookIngestJobData>;
  scoreRecomputeQueue: Queue<ScoreRecomputeJobData>;
}>;

/**
 * Every queue apps/worker touches, built once and shared across its three processors —
 * the delivery processor enqueues onto `fallbackQueue`, the fallback-timer and
 * webhook-ingest processors both enqueue onto `deliveryQueue`, so these can't each own
 * a private copy.
 */
export function createQueues(connection: Redis): Queues {
  return {
    deliveryQueue: new Queue<DeliveryJobData>(DELIVERY_QUEUE_NAME, { connection }),
    deadLetterQueue: new Queue<DeadLetterRecord>(DELIVERY_DLQ_NAME, { connection }),
    fallbackQueue: new Queue<FallbackTimerJobData>(FALLBACK_TIMER_QUEUE_NAME, { connection }),
    webhookIngestQueue: new Queue<WebhookIngestJobData>(WEBHOOK_INGEST_QUEUE_NAME, { connection }),
    scoreRecomputeQueue: new Queue<ScoreRecomputeJobData>(SCORE_RECOMPUTE_QUEUE_NAME, {
      connection,
    }),
  };
}

export async function closeQueues(queues: Queues): Promise<void> {
  await Promise.all([
    queues.deliveryQueue.close(),
    queues.deadLetterQueue.close(),
    queues.fallbackQueue.close(),
    queues.webhookIngestQueue.close(),
    queues.scoreRecomputeQueue.close(),
  ]);
}
