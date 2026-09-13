export const FALLBACK_TIMER_QUEUE_NAME = "fallback-timer";

/** Deterministic job ID so cancellation (best-effort) is a plain `queue.remove(id)`. */
export function fallbackTimerJobId(attemptId: string): string {
  return `fallback-${attemptId}`;
}

export type FallbackTimerJobData = Readonly<{
  attemptId: string;
  verificationId: string;
  accountId: string;
  channel: string;
  correlationId: string;
}>;
