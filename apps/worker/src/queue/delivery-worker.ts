import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import type { PgClient } from "@otp-router/db/client";
import type { Channel } from "@otp-router/core/fallback/channel-chain";
import { DELIVERY_QUEUE_NAME, type DeliveryJobData } from "@otp-router/core/queue/delivery-job";
import type { Provider } from "@otp-router/providers/provider";
import { createDeliveryProcessor } from "../processors/delivery.js";
import type { FallbackKeys } from "../services/fallback.js";
import type { Queues } from "./queues.js";

export function createDeliveryWorker(
  connection: Redis,
  pg: PgClient,
  // Pick<>, not Provider — see DeliveryProcessorDeps.provider.
  provider: Pick<Provider, "send" | "mapErrorCode">,
  logger: Logger,
  queues: Queues,
  keys: FallbackKeys,
  // Test-only override — see DeliveryProcessorDeps.channelTimeoutMs.
  channelTimeoutMs?: Readonly<Record<Channel, number>>,
  // See DeliveryProcessorDeps.providerName.
  providerName?: Readonly<Partial<Record<Channel, string>>>,
): Worker<DeliveryJobData> {
  const processDelivery = createDeliveryProcessor({
    pg,
    provider,
    logger,
    deadLetterQueue: queues.deadLetterQueue,
    deliveryQueue: queues.deliveryQueue,
    fallbackQueue: queues.fallbackQueue,
    keys,
    channelTimeoutMs,
    providerName,
  });

  const worker = new Worker<DeliveryJobData>(DELIVERY_QUEUE_NAME, processDelivery, {
    connection,
    // Only one send in flight at a time per worker process — Phase 5 routing/volume
    // decisions belong to the queue's concurrency knob, not a magic number picked now.
    concurrency: 5,
  });

  worker.on("failed", (job, err) => {
    logger.error(
      { attemptId: job?.data.attemptId, correlationId: job?.data.correlationId, err },
      "delivery job failed",
    );
  });

  return worker;
}
