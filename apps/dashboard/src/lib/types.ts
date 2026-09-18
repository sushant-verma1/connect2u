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

// Mirrors apps/api/src/routes/demo.ts's /v1/demo/routing/* responses — hand-kept in
// sync, same convention as `Trace` above.
export type DemoChannel = "whatsapp" | "sms";
export type DemoPhase = "calibration" | "adaptive" | "complete";

export type DemoChannelOutcome = {
  channel: DemoChannel;
  outcome: "verified" | "timeout";
  latency_ms: number;
};

export type DemoAttempt = {
  attempt: number;
  phase: "calibration" | "adaptive";
  routed_channel: DemoChannel;
  final_channel: DemoChannel;
  fallback_used: boolean;
  verified: true;
  timeout_ms: number;
  latency_ms: number;
  primary: DemoChannelOutcome;
  fallback: DemoChannelOutcome | null;
  decision_log: DecisionLogEntry[];
};

// An adaptive attempt the router has decided on but the visitor hasn't resolved yet --
// exactly one of `routed_channel`/`fallback_channel` is ever clickable at a time (§4 of
// the interaction spec): `routed_channel` before `priority_deadline_ms`, otherwise
// `fallback_channel`. The countdown itself is derived client-side from
// `priority_deadline_ms - Date.now()`; the server is what actually enforces which
// channel a `/verify` call may name.
export type DemoPendingAdaptive = {
  attempt: number;
  routed_channel: DemoChannel;
  fallback_channel: DemoChannel | null;
  reason: string;
  decision_log: DecisionLogEntry[];
  timeout_ms: number;
  started_at_ms: number;
  priority_deadline_ms: number;
};

export type DemoPhaseCounts = { completed: number; total: number };

export type DemoSessionSummary = {
  phase: DemoPhase;
  calibration: DemoPhaseCounts;
  adaptive: DemoPhaseCounts;
};

export type DemoStartResponse = DemoSessionSummary & { session_id: string };
export type DemoStepResponse = DemoSessionSummary & { attempt: DemoAttempt };
export type DemoBeginAdaptiveResponse = DemoSessionSummary & { pending: DemoPendingAdaptive };
export type DemoSessionState = DemoSessionSummary & {
  session_id: string;
  attempts: DemoAttempt[];
  pending: DemoPendingAdaptive | null;
};

export type DemoReport = {
  calibration: DemoAttempt[];
  adaptive: DemoAttempt[];
  channel_usage: { whatsapp: number; sms: number };
  success_rate: { whatsapp: number; sms: number };
  avg_latency_ms: { whatsapp: number | null; sms: number | null };
  fallback_counts: { whatsapp_to_sms: number; sms_to_whatsapp: number };
  routing_changes: number;
  fallback_events: number;
  final_channel: DemoChannel;
  explanation: string;
};
