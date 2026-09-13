import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import type { PgClient } from "@otp-router/db/client";
import {
  WEBHOOK_INGEST_QUEUE_NAME,
  type WebhookIngestJobData,
} from "@otp-router/core/queue/webhook-job";
import { createWebhookIngestProcessor } from "../processors/webhook-ingest.js";
import type { FallbackKeys } from "../services/fallback.js";
import type { Queues } from "./queues.js";

export function createWebhookIngestWorker(
  connection: Redis,
  pg: PgClient,
  logger: Logger,
  queues: Queues,
  keys: FallbackKeys,
): Worker<WebhookIngestJobData> {
  const processWebhookIngest = createWebhookIngestProcessor(
    pg,
    queues.deliveryQueue,
    queues.fallbackQueue,
    keys,
    logger,
  );

  const worker = new Worker<WebhookIngestJobData>(WEBHOOK_INGEST_QUEUE_NAME, processWebhookIngest, {
    connection,
  });

  worker.on("failed", (job, err) => {
    logger.error(
      {
        providerMessageId: job?.data.providerMessageId,
        correlationId: job?.data.correlationId,
        err,
      },
      "webhook ingest job failed",
    );
  });

  return worker;
}
