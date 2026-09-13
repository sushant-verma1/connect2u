// R3.8: precomputed on a schedule, never at request time — ARCHITECTURE.md §6's
// score-recompute job, every 15 minutes. No payload: each run recomputes from whatever
// is in Postgres right now.
export const SCORE_RECOMPUTE_QUEUE_NAME = "score-recompute";
export const SCORE_RECOMPUTE_JOB_ID = "score-recompute-repeatable";
export const SCORE_RECOMPUTE_INTERVAL_MS = 15 * 60 * 1000;

export type ScoreRecomputeJobData = Readonly<Record<string, never>>;
