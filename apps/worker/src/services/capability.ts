import type { PgClient } from "@otp-router/db/client";
import { findVerificationScoped } from "@otp-router/db/repositories/verifications";
import {
  findCapabilityByPhoneHash,
  upsertCapability,
} from "@otp-router/db/repositories/channel-capability";
import { isChannel } from "@otp-router/core/fallback/channel-chain";
import {
  applyDeliveryOutcome,
  initialCapabilityRecord,
} from "@otp-router/core/routing/capability-update";
import { DEMO_ACCOUNT_ID } from "@otp-router/core/demo";

export type CapabilityOutcomeParams = Readonly<{
  verificationId: string;
  accountId: string;
  channel: string;
}>;

/**
 * R3.6: written after a delivery outcome actually resolves — `delivered` is a success,
 * `failed`/`timed_out` is a failure. `sent` alone is neither: a send can succeed and
 * never be confirmed delivered, which is exactly the case a fallback timeout models.
 * All the I/O (reading the verification for its phone_hash, reading/writing the
 * capability row) lives here in apps/worker; the decay/update math itself is the pure
 * `applyDeliveryOutcome` from packages/core (I1).
 */
export async function updateCapabilityForOutcome(
  pg: PgClient,
  params: CapabilityOutcomeParams,
  outcome: "success" | "failure",
  now: Date,
): Promise<void> {
  if (!isChannel(params.channel)) return;
  // Defence in depth, not a load-bearing guard today: the public demo
  // (apps/api/src/routes/demo.ts) is a pure simulation over a Redis session and never
  // calls startVerification, so no real delivery outcome should ever arrive here
  // tagged with DEMO_ACCOUNT_ID. Kept anyway — this is the one choke point every
  // fallback trigger (webhook-ingest.ts ×2, fallback-timer.ts, delivery.ts) already
  // routes through, so if that ever changes, a per-phone-hash capability record for
  // the demo's account still can't leak into real accounts' routing decisions
  // (channel_capability has no account_id column at all).
  if (params.accountId === DEMO_ACCOUNT_ID) return;

  const verification = await findVerificationScoped(pg, params.verificationId, params.accountId);
  if (!verification) return;

  const existing = await findCapabilityByPhoneHash(pg, verification.phoneHash);
  const current =
    existing.find((record) => record.channel === params.channel) ??
    initialCapabilityRecord(params.channel, now);

  const updated = applyDeliveryOutcome(current, outcome, now);
  await upsertCapability(pg, verification.phoneHash, updated);
}
