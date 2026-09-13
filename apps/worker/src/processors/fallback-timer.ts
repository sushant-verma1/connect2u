import type { Job, Queue } from "bullmq";
import type { Logger } from "pino";
import type { PgClient } from "@otp-router/db/client";
import { markDeliveryAttemptTimedOut } from "@otp-router/db/repositories/delivery-attempts";
import type { DeliveryJobData } from "@otp-router/core/queue/delivery-job";
import type { FallbackTimerJobData } from "@otp-router/core/queue/fallback-job";
import { advanceOrFail, type FallbackKeys } from "../services/fallback.js";

/**
 * R4.4 trigger #3 (timeout). This job always fires at T+timeout regardless of what
 * happened to the attempt in the meantime — cancellation on success is best-effort
 * (ARCHITECTURE.md §6), so this conditional UPDATE is the real guard. If a webhook
 * already resolved the attempt (`delivered` or `failed`), the UPDATE matches zero rows
 * and this is a no-op that still completes successfully (R4.3/I9), never an error.
 */
export function createFallbackTimerProcessor(
  pg: PgClient,
  deliveryQueue: Queue<DeliveryJobData>,
  keys: FallbackKeys,
  logger: Logger,
) {
  return async function processFallbackTimer(job: Job<FallbackTimerJobData>): Promise<void> {
    const { attemptId, verificationId, accountId, channel, correlationId } = job.data;
    const log = logger.child({ correlationId, attemptId, verificationId });

    const timedOut = await markDeliveryAttemptTimedOut(pg, { id: attemptId });
    if (!timedOut) {
      log.info("fallback timer fired against an already-resolved attempt — no-op");
      return;
    }

    log.info({ channel }, "delivery timed out — advancing fallback chain");
    await advanceOrFail(pg, deliveryQueue, keys, { verificationId, accountId, correlationId });
  };
}
