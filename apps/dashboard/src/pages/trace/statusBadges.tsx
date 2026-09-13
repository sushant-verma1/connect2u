import { Badge, type BadgeVariant } from "../../components/ui/badge";
import type { AttemptStatus, DecisionAction, VerificationStatus } from "../../lib/types";

const VERIFICATION_VARIANT: Record<VerificationStatus, BadgeVariant> = {
  pending: "warning",
  verified: "success",
  expired: "neutral",
  burned: "danger",
  failed: "danger",
};

const ATTEMPT_VARIANT: Record<AttemptStatus, BadgeVariant> = {
  queued: "neutral",
  sent: "info",
  delivered: "success",
  failed: "danger",
  timed_out: "warning",
};

const ACTION_VARIANT: Record<DecisionAction, BadgeVariant> = {
  considered: "neutral",
  chosen: "success",
  skipped: "danger",
  reordered: "info",
};

export function VerificationStatusBadge({ status }: { status: VerificationStatus }) {
  return <Badge variant={VERIFICATION_VARIANT[status]}>{status}</Badge>;
}

export function AttemptStatusBadge({ status }: { status: AttemptStatus }) {
  return <Badge variant={ATTEMPT_VARIANT[status]}>{status.replace("_", " ")}</Badge>;
}

export function DecisionActionBadge({ action }: { action: DecisionAction }) {
  return <Badge variant={ACTION_VARIANT[action]}>{action}</Badge>;
}
