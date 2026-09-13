import type { Job, Queue } from "bullmq";
import { UnrecoverableError } from "bullmq";
import type { Logger } from "pino";
import type { PgClient } from "@otp-router/db/client";
import {
  findDeliveryAttempt,
  markDeliveryAttemptFailed,
  markDeliveryAttemptSent,
} from "@otp-router/db/repositories/delivery-attempts";
import { findApplicableRate } from "@otp-router/db/repositories/provider-rates";
import {
  CHANNEL_TIMEOUT_MS,
  isChannel,
  type Channel,
} from "@otp-router/core/fallback/channel-chain";
import type { DeadLetterRecord, DeliveryJobData } from "@otp-router/core/queue/delivery-job";
import { fallbackTimerJobId, type FallbackTimerJobData } from "@otp-router/core/queue/fallback-job";
import { classifyCountry } from "@otp-router/core/pricing/country";
import { isPermanentError, type Provider } from "@otp-router/providers/provider";
import { advanceOrFail, type FallbackKeys } from "../services/fallback.js";
import { updateCapabilityForOutcome } from "../services/capability.js";

/**
 * Whether bullmq will attempt this job again after the current run fails. Mirrors
 * bullmq's own `Job.shouldRetryJob` check — `attemptsMade` counts attempts made
 * *before* this run, so `attemptsMade + 1` is this run's ordinal.
 */
function isFinalAttempt(job: Job<DeliveryJobData>): boolean {
  return job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
}

export type DeliveryProcessorDeps = Readonly<{
  pg: PgClient;
  provider: Provider;
  logger: Logger;
  deadLetterQueue: Queue<DeadLetterRecord>;
  deliveryQueue: Queue<DeliveryJobData>;
  fallbackQueue: Queue<FallbackTimerJobData>;
  keys: FallbackKeys;
  // Overridable for tests only — production always uses `job.data.timeoutMs`, the
  // per-channel value the routing pipeline computed at /start time (R4.5), never a
  // global constant. This escape hatch exists purely so race tests can run on a
  // deterministic, fast clock instead of waiting out real 20s/30s timeouts.
  channelTimeoutMs?: Readonly<Partial<Record<Channel, number>>>;
}>;

/**
 * Phase 2 exit gate: a worker killed mid-send and restarted must not double-send and
 * must not lose the verification. Idempotency comes from `delivery_attempts` in
 * Postgres, not from bullmq — if a prior run already reached a terminal status for
 * this attempt, this run is a redelivery of an already-resolved job and no-ops.
 */
export function createDeliveryProcessor(deps: DeliveryProcessorDeps) {
  const {
    pg,
    provider,
    logger,
    deadLetterQueue,
    deliveryQueue,
    fallbackQueue,
    keys,
    channelTimeoutMs,
  } = deps;

  return async function processDelivery(job: Job<DeliveryJobData>): Promise<void> {
    const {
      attemptId,
      verificationId,
      accountId,
      phoneNumber,
      code,
      channel,
      correlationId,
      timeoutMs,
    } = job.data;
    const log = logger.child({ correlationId, attemptId, verificationId });

    const existing = await findDeliveryAttempt(pg, attemptId);
    if (existing && existing.status !== "queued") {
      log.info({ status: existing.status }, "delivery attempt already resolved — skipping resend");
      return;
    }

    try {
      const result = await provider.send({ phoneNumber, code, channel });

      // G8: looked up by the channel's real-world provider (Meta for WhatsApp) even
      // though sends currently run through SimulatedProvider (PROJECT.md's WABA
      // constraint) — the cost is what the channel actually costs, not an artifact of
      // which adapter relayed it. Missing rate data degrades to null, never an error —
      // but it's logged loudly: a silent null here is invisible to `SUM(cost_micros_at_send)`,
      // and Phase 7's daily-spend ceiling reads exactly that sum to catch toll fraud.
      const rateParams = {
        provider: channel === "whatsapp" ? "meta" : "generic_sms",
        channel,
        country: classifyCountry(phoneNumber),
        messageType: "authentication",
      };
      const rate = await findApplicableRate(pg, rateParams);
      if (!rate) {
        log.warn(rateParams, "no applicable provider_rates row — cost_micros_at_send will be null");
      }

      await markDeliveryAttemptSent(pg, {
        id: attemptId,
        providerMessageId: result.providerMessageId,
        costMicrosAtSend: rate?.rateMicros,
        country: rateParams.country,
      });
      log.info("delivery sent");

      // R4.2: the fallback timer is scheduled at send time, not at /start time — it
      // only exists once there's something to time out.
      if (isChannel(channel)) {
        const delay = channelTimeoutMs?.[channel] ?? timeoutMs ?? CHANNEL_TIMEOUT_MS[channel];
        await fallbackQueue.add(
          "timeout",
          { attemptId, verificationId, accountId, channel, correlationId },
          { delay, jobId: fallbackTimerJobId(attemptId) },
        );
      }
    } catch (err) {
      const errorCode = provider.mapErrorCode(err);
      const permanent = isPermanentError(errorCode);
      const final = permanent || isFinalAttempt(job);

      if (final) {
        await markDeliveryAttemptFailed(pg, { id: attemptId, errorCode });
        await deadLetterQueue.add("dead-letter", {
          attemptId,
          verificationId,
          accountId,
          channel,
          errorCode,
          errorMessage: err instanceof Error ? err.message : String(err),
          attemptsMade: job.attemptsMade + 1,
          failedAt: new Date().toISOString(),
          correlationId,
        });
        // R3.6: the send itself never succeeded on this channel for this number.
        await updateCapabilityForOutcome(
          pg,
          { verificationId, accountId, channel },
          "failure",
          new Date(),
        );
        // R4.4 trigger #1: a hard provider error — permanent, or transient with
        // retries exhausted — advances the fallback chain immediately rather than
        // waiting for a timer that was never scheduled (the send never succeeded).
        await advanceOrFail(pg, deliveryQueue, keys, { verificationId, accountId, correlationId });
      }

      log.warn({ errorCode, permanent, final }, "delivery attempt failed");

      if (permanent) {
        throw new UnrecoverableError(errorCode);
      }
      throw err;
    }
  };
}
