import type { PgClient } from "@otp-router/db/client";
import { isChannel, type Channel } from "@otp-router/core/fallback/channel-chain";
import {
  findVerificationByIdempotencyKey,
  type Verification,
} from "@otp-router/db/repositories/verifications";

export type StartResponseBody = Readonly<{
  verification_id: string;
  status: "pending";
  channel_attempted: Channel;
  expires_at: string;
}>;

/**
 * R1.1.6/T4: the original `/start` response is never cached separately — it's fully
 * reconstructible from the verification row itself, so there's nothing to keep in sync
 * or let go stale. `status` is always the literal `"pending"` here because that's what
 * every `/start` response says regardless of what's happened since (a replay reports
 * what the *original call* returned, not the verification's current state).
 */
export function toStartResponse(verification: Verification): StartResponseBody {
  const channelAttempted = verification.channelChain[0];
  if (!channelAttempted || !isChannel(channelAttempted)) {
    throw new Error(`verification ${verification.id} has an invalid channel_chain`);
  }
  return {
    verification_id: verification.id,
    status: "pending",
    channel_attempted: channelAttempted,
    expires_at: verification.expiresAt.toISOString(),
  };
}

/** Looks up a prior `/start` call by `Idempotency-Key`, scoped to this account — the
 * caller (verification.ts) uses this both before attempting an insert and again, on a
 * unique-violation, to fetch whichever concurrent request won the race. */
export async function findReplayedStart(
  pg: PgClient,
  accountId: string,
  idempotencyKey: string,
): Promise<StartResponseBody | null> {
  const existing = await findVerificationByIdempotencyKey(pg, accountId, idempotencyKey);
  return existing ? toStartResponse(existing) : null;
}
