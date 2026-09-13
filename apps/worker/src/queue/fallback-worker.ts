import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import type { PgClient } from "@otp-router/db/client";
import {
  FALLBACK_TIMER_QUEUE_NAME,
  type FallbackTimerJobData,
} from "@otp-router/core/queue/fallback-job";
import { createFallbackTimerProcessor } from "../processors/fallback-timer.js";
import type { FallbackKeys } from "../services/fallback.js";
import type { Queues } from "./queues.js";

export function createFallbackTimerWorker(
  connection: Redis,
  pg: PgClient,
  logger: Logger,
  queues: Queues,
  keys: FallbackKeys,
): Worker<FallbackTimerJobData> {
  const processFallbackTimer = createFallbackTimerProcessor(pg, queues.deliveryQueue, keys, logger);

  const worker = new Worker<FallbackTimerJobData>(FALLBACK_TIMER_QUEUE_NAME, processFallbackTimer, {
    connection,
  });

  worker.on("failed", (job, err) => {
    logger.error(
      { attemptId: job?.data.attemptId, correlationId: job?.data.correlationId, err },
      "fallback timer job failed",
    );
  });

  return worker;
}
