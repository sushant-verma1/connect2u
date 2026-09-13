// Mirrors apps/api/src/routes/verification.ts's traceResponseSchema exactly — hand-kept
// in sync rather than imported, the same way any external API consumer would have to;
// the dashboard reads this API over HTTP, it doesn't share internals with it.

export type VerificationStatus = "pending" | "verified" | "expired" | "burned" | "failed";
export type AttemptStatus = "queued" | "sent" | "delivered" | "failed" | "timed_out";
export type DecisionStage = "match_policy" | "capability_filter" | "score_rank" | "cost_ceiling";
export type DecisionAction = "considered" | "skipped" | "reordered" | "chosen";

export type DecisionLogEntry = {
  stage: DecisionStage;
  action: DecisionAction;
  channel?: string;
  reason: string;
};

export type TraceWebhookEvent = {
  provider: string;
  event_type: string;
  signature_valid: boolean | null;
  created_at: string;
};

export type TraceAttempt = {
  id: string;
  channel: string;
  provider: string;
  status: AttemptStatus;
  error_code: string | null;
  cost_micros_at_send: number | null;
  sent_at: string | null;
  delivered_at: string | null;
  failed_at: string | null;
  timeout_at: string | null;
  webhook_events: TraceWebhookEvent[];
};

export type Trace = {
  verification_id: string;
  status: VerificationStatus;
  channel_chain: string[];
  channel_timeouts_ms: Record<string, number>;
  attempts_used: number;
  max_attempts: number;
  created_at: string;
  expires_at: string;
  verified_at: string | null;
  verified_channel: string | null;
  time_to_verify_ms: number | null;
  routing_decision: {
    considered: string[];
    chosen_channel: string | null;
    decision_log: DecisionLogEntry[];
  } | null;
  attempts: TraceAttempt[];
};
