import type { Channel } from "../fallback/channel-chain.js";
import type { CapabilityRecord } from "./types.js";

// ponytail: exponential decay with a fixed half-life and flat +/-0.3 nudges per
// outcome is a naive heuristic, not a fitted model — there's no real-traffic data yet
// to fit one against. Ceiling: revisit once channel_scores has enough history to
// correlate a decay curve against actual re-verification behaviour.
const CONFIDENCE_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const OUTCOME_DELTA = 0.3;
const LIKELY_THRESHOLD = 0.5;
const NEUTRAL_CONFIDENCE = 0.5;

/** R3.6: confidence decays with age. Pure — "now" is always the caller's clock, never
 * read internally (I1). */
export function decayConfidence(confidence: number, ageMs: number): number {
  if (ageMs <= 0) return confidence;
  return confidence * 0.5 ** (ageMs / CONFIDENCE_HALF_LIFE_MS);
}

/** G3: a channel this phone_hash has never been tried on — neutral until evidence says
 * otherwise, so a genuinely unknown number gets one bounded attempt rather than being
 * starved by a default of zero. */
export function initialCapabilityRecord(channel: Channel, now: Date): CapabilityRecord {
  return {
    channel,
    capability: "unknown",
    confidence: NEUTRAL_CONFIDENCE,
    lastSuccessAt: null,
    consecutiveFailures: 0,
    updatedAt: now,
  };
}

/** R3.6: success raises confidence and clears the failure streak; failure lowers
 * confidence and extends it. Both start from the *decayed* confidence at `now`, not the
 * stale stored value — an outcome after a long gap shouldn't inherit certainty that has
 * already aged out. */
export function applyDeliveryOutcome(
  record: CapabilityRecord,
  outcome: "success" | "failure",
  now: Date,
): CapabilityRecord {
  const decayed = decayConfidence(record.confidence, now.getTime() - record.updatedAt.getTime());

  if (outcome === "success") {
    const confidence = Math.min(1, decayed + OUTCOME_DELTA);
    return {
      ...record,
      confidence,
      capability: confidence >= LIKELY_THRESHOLD ? "likely" : record.capability,
      lastSuccessAt: now,
      consecutiveFailures: 0,
      updatedAt: now,
    };
  }

  const confidence = Math.max(0, decayed - OUTCOME_DELTA);
  const consecutiveFailures = record.consecutiveFailures + 1;
  return {
    ...record,
    confidence,
    capability: consecutiveFailures >= 2 ? "unlikely" : record.capability,
    consecutiveFailures,
    updatedAt: now,
  };
}
