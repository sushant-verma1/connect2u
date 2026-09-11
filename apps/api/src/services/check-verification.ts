import type { PgClient } from "@otp-router/db/client";
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
      channel: verification.verifiedChannel ?? "whatsapp",
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
