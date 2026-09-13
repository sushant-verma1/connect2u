import { decayConfidence } from "./capability-update.js";
import type { CandidateChannel, CapabilityRecord, DecisionLogEntry } from "./types.js";

const CONSECUTIVE_FAILURE_DROP_THRESHOLD = 2;

/** Confidence-weighted position: "likely" pulls a channel forward, "unlikely" pushes it
 * back, "unknown" (no record, or the cache has never seen this phone_hash on this
 * channel) is neutral and keeps its policy-given order — G3's "one bounded attempt". */
function capabilityScore(record: CapabilityRecord | undefined, now: Date): number {
  if (!record) return 0;
  const confidence = decayConfidence(record.confidence, now.getTime() - record.updatedAt.getTime());
  if (record.capability === "likely") return confidence;
  if (record.capability === "unlikely") return -confidence;
  return 0;
}

export type FilterByCapabilityResult = Readonly<{
  candidates: readonly CandidateChannel[];
  decisionLog: readonly DecisionLogEntry[];
}>;

/** R3.6: stage ② — drops channels with two or more consecutive failures for this
 * phone_hash, then reorders what's left by confidence-weighted capability. A stable
 * sort preserves the policy's relative order between channels at the same score. */
export function filterByCapability(
  candidates: readonly CandidateChannel[],
  capabilityRecords: readonly CapabilityRecord[],
  now: Date,
): FilterByCapabilityResult {
  const byChannel = new Map(capabilityRecords.map((record) => [record.channel, record]));
  const decisionLog: DecisionLogEntry[] = [];

  const kept = candidates.filter((candidate) => {
    const record = byChannel.get(candidate.channel);
    if (record && record.consecutiveFailures >= CONSECUTIVE_FAILURE_DROP_THRESHOLD) {
      decisionLog.push({
        stage: "capability_filter",
        action: "skipped",
        channel: candidate.channel,
        reason: `${record.consecutiveFailures} consecutive failures on this number (>= ${CONSECUTIVE_FAILURE_DROP_THRESHOLD})`,
      });
      return false;
    }
    return true;
  });

  const reordered = [...kept].sort(
    (a, b) =>
      capabilityScore(byChannel.get(b.channel), now) -
      capabilityScore(byChannel.get(a.channel), now),
  );

  if (reordered.map((c) => c.channel).join() !== kept.map((c) => c.channel).join()) {
    decisionLog.push({
      stage: "capability_filter",
      action: "reordered",
      reason: `reordered by confidence-weighted capability: [${reordered.map((c) => c.channel).join(", ")}]`,
    });
  }

  return { candidates: reordered, decisionLog };
}
