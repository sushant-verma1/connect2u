import type { PgClient } from "@otp-router/db/client";
import {
  findDeliveryAttemptsByVerification,
  type DeliveryAttempt,
} from "@otp-router/db/repositories/delivery-attempts";
import {
  findVerificationScoped,
  markExpired,
  markVerified,
  recordFailedAttempt,
  type Verification,
} from "@otp-router/db/repositories/verifications";
import {
  outcomeForTerminalStatus,
  type CheckOutcome,
} from "@otp-router/core/state-machine/check-outcome";
import { hmacMatches } from "../crypto/hmac.js";

export type CheckResult = Readonly<{
  outcome: CheckOutcome;
  verification: Verification | null;
}>;

/**
 * I2: the only writes here are the single atomic conditional UPDATEs in the
 * repository layer. This function reads current state to decide *which* outcome to
 * report, but never performs a read-then-write on the status column itself.
 */
export async function checkVerification(
  pg: PgClient,
  params: { verificationId: string; accountId: string; code: string; otpPepper: string },
): Promise<CheckResult> {
  const verification = await findVerificationScoped(pg, params.verificationId, params.accountId);
  if (!verification) {
    return { outcome: "not_found", verification: null };
  }

  if (verification.status !== "pending") {
    return { outcome: outcomeForTerminalStatus(verification.status), verification };
  }

  const codeMatches = hmacMatches(params.code, params.otpPepper, verification.codeHmac);

  if (codeMatches) {
    const updated = await markVerified(pg, {
      id: params.verificationId,
      accountId: params.accountId,
      channel: await attributeChannel(pg, params.verificationId),
      timeToVerifyMs: Date.now() - verification.createdAt.getTime(),
    });
    if (updated) {
      return { outcome: "verified", verification: updated };
    }
    return resolveLostRace(pg, params, verification);
  }

  const updated = await recordFailedAttempt(pg, {
    id: params.verificationId,
    accountId: params.accountId,
  });
  if (updated) {
    return {
      outcome: updated.status === "burned" ? "attempts_exceeded" : "invalid_code",
      verification: updated,
    };
  }
  return resolveLostRace(pg, params, verification);
}

/**
 * G1/R3.7: which channel gets credit for this verification.
 *
 * There is no measurement available here. Every channel in a chain carries the *same*
 * code by design (R2.3 — it is never regenerated on fallback), and nothing in the
 * system observes which message a user actually read; `/check` receives six digits and
 * no provenance. Attribution is therefore a stated convention, not an observation, and
 * the only honest question is which convention is least wrong.
 *
 * The convention: the most recently `delivered` attempt, falling back to the most
 * recently `sent` one when no delivery was ever confirmed.
 *
 * Why not first-attempt: `channel_scores` divides verifications by sends per channel
 * (packages/db/src/repositories/channel-scores.ts), and that ratio is what
 * `rankByScore` orders the chain on. Crediting the first attempt would credit the
 * channel that routing already picked first, so the score would measure chain position
 * rather than channel performance and would then feed itself. Last-delivered is
 * biased the other way — toward whichever channel the chain ended on — but that is the
 * channel whose message was most recently in front of the user, and it is the only rule
 * that can ever move credit *away* from the incumbent first choice.
 *
 * Returns null when no attempt was ever sent (nothing was in front of the user to
 * read). Null is recorded and surfaced as null; it is never defaulted to a channel
 * name — a plausible default here is indistinguishable from a measurement and hid a
 * broken metric for six phases (docs/findings/channel-attribution.md).
 */
async function attributeChannel(pg: PgClient, verificationId: string): Promise<string | null> {
  const attempts = await findDeliveryAttemptsByVerification(pg, verificationId);
  const attributed =
    latestAt(attempts, (a) => a.deliveredAt) ?? latestAt(attempts, (a) => a.sentAt);
  return attributed?.channel ?? null;
}

/** Latest attempt by an event timestamp, ignoring attempts where it is null. Ordered
 * on the event time rather than on attempt id: a late `delivered` webhook (R4.8) can
 * land after a subsequent channel was already sent. */
function latestAt(
  attempts: readonly DeliveryAttempt[],
  pick: (attempt: DeliveryAttempt) => Date | null,
): DeliveryAttempt | null {
  let latest: DeliveryAttempt | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const attempt of attempts) {
    const at = pick(attempt);
    if (at && at.getTime() >= latestMs) {
      latest = attempt;
      latestMs = at.getTime();
    }
  }
  return latest;
}

/**
 * Our conditional UPDATE matched zero rows. Someone else already won the race, or the
 * verification expired between our read and our write — re-read to report which.
 */
async function resolveLostRace(
  pg: PgClient,
  params: { verificationId: string; accountId: string },
  readAt: Verification,
): Promise<CheckResult> {
  const current = await findVerificationScoped(pg, params.verificationId, params.accountId);
  if (!current) {
    return { outcome: "not_found", verification: null };
  }
  if (current.status !== "pending") {
    return { outcome: outcomeForTerminalStatus(current.status), verification: current };
  }
  if (readAt.expiresAt.getTime() <= Date.now()) {
    const expired = await markExpired(pg, {
      id: params.verificationId,
      accountId: params.accountId,
    });
    return { outcome: "expired", verification: expired ?? current };
  }
  // Genuinely lost a concurrent race but the row is still pending — should not happen
  // in practice (the winner's write is visible by the time ours returns zero rows).
  return { outcome: "invalid_code", verification: current };
}
