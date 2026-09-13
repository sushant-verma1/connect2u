import type { PgClient } from "@otp-router/db/client";
import {
  findVerificationScoped,
  type Verification,
} from "@otp-router/db/repositories/verifications";
import {
  findDeliveryAttemptsByVerification,
  type DeliveryAttempt,
} from "@otp-router/db/repositories/delivery-attempts";
import { findRoutingDecisionByVerification } from "@otp-router/db/repositories/routing-decisions";
import {
  findWebhookEventsByProviderMessageIds,
  type WebhookEvent,
} from "@otp-router/db/repositories/webhook-events";

export type TraceAttempt = DeliveryAttempt & { webhookEvents: readonly WebhookEvent[] };

export type Trace = Readonly<{
  verification: Verification;
  routingDecision: Awaited<ReturnType<typeof findRoutingDecisionByVerification>>;
  attempts: readonly TraceAttempt[];
}>;

/**
 * R10.6: everything the trace view renders, assembled in one place — the verification
 * itself, the one routing decision that chose its channel chain (with every channel
 * considered and every skip reason, R3.9), and each delivery attempt paired with the
 * webhook events that resolved it. `webhook_events` has no `verification_id` of its
 * own (R6.2 keys it on `(provider, provider_message_id)`), so that join happens here,
 * through each attempt's `provider_message_id`, rather than in the schema.
 */
export async function buildTrace(
  pg: PgClient,
  params: { verificationId: string; accountId: string },
): Promise<Trace | null> {
  const verification = await findVerificationScoped(pg, params.verificationId, params.accountId);
  if (!verification) return null;

  const [routingDecision, attempts] = await Promise.all([
    findRoutingDecisionByVerification(pg, params.verificationId),
    findDeliveryAttemptsByVerification(pg, params.verificationId),
  ]);

  const providerMessageIds = attempts
    .map((attempt) => attempt.providerMessageId)
    .filter((id): id is string => id !== null);
  const webhookEvents = await findWebhookEventsByProviderMessageIds(pg, providerMessageIds);

  const attemptsWithEvents = attempts.map((attempt) => ({
    ...attempt,
    webhookEvents: webhookEvents.filter(
      (event) => event.providerMessageId === attempt.providerMessageId,
    ),
  }));

  return { verification, routingDecision, attempts: attemptsWithEvents };
}
