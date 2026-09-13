import { ulid } from "ulid";
import type { Queue } from "bullmq";
import type { PgClient } from "@otp-router/db/client";
import { findVerificationScoped, markFailed } from "@otp-router/db/repositories/verifications";
import {
  findDeliveryAttemptsByVerification,
  insertDeliveryAttempt,
} from "@otp-router/db/repositories/delivery-attempts";
import { isChannel, nextChannel } from "@otp-router/core/fallback/channel-chain";
import type { DeliveryJobData } from "@otp-router/core/queue/delivery-job";
import { decryptString } from "../crypto/aes-gcm.js";

export type FallbackKeys = Readonly<{ phoneEncryptionKey: string; codeEncryptionKey: string }>;

export type AdvanceOrFailParams = Readonly<{
  verificationId: string;
  accountId: string;
  correlationId: string;
}>;

/**
 * The single place every fallback trigger (R4.4: hard provider error, delivery-failed
 * webhook, timeout) converges. Advances to the next channel in the chain, or marks the
 * verification terminally `failed` once the chain is exhausted.
 *
 * R4.3/I9: re-reads the verification and no-ops if it's no longer `pending` — a
 * terminal verification (already verified, expired, burned, or already failed by a
 * concurrent trigger) means this call is a duplicate or a lost race, not an error.
 */
export async function advanceOrFail(
  pg: PgClient,
  deliveryQueue: Queue<DeliveryJobData>,
  keys: FallbackKeys,
  params: AdvanceOrFailParams,
): Promise<void> {
  const verification = await findVerificationScoped(pg, params.verificationId, params.accountId);
  if (!verification || verification.status !== "pending") return;

  const attempts = await findDeliveryAttemptsByVerification(pg, verification.id);
  const attemptedChannels = attempts.map((attempt) => attempt.channel);
  const chain = verification.channelChain.filter(isChannel);
  const channel = nextChannel(chain, attemptedChannels);

  if (!channel) {
    await markFailed(pg, { id: verification.id, accountId: verification.accountId });
    return;
  }

  // R2.3: the exact same code every channel was ever going to send — decrypted, never
  // regenerated.
  const phoneNumber = decryptString(verification.phoneEncrypted, keys.phoneEncryptionKey);
  const code = decryptString(verification.codeEncrypted, keys.codeEncryptionKey);
  const attemptId = `att_${ulid()}`;

  await insertDeliveryAttempt(pg, {
    id: attemptId,
    verificationId: verification.id,
    accountId: verification.accountId,
    channel,
    provider: "simulated",
    status: "queued",
  });

  await deliveryQueue.add(
    "send",
    {
      attemptId,
      verificationId: verification.id,
      accountId: verification.accountId,
      phoneNumber,
      code,
      channel,
      correlationId: params.correlationId,
    },
    { jobId: attemptId },
  );
}
