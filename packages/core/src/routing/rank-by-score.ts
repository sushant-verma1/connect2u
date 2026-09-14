import type { CandidateChannel, ChannelScoreRecord, DecisionLogEntry } from "./types.js";

// G3/G4 cold start: a channel with no score history yet is neither penalised nor
// favoured on the primary key — it ranks as an average performer — but loses latency
// tie-breaks to anything actually measured, so a known-fast channel wins ties over an
// unmeasured guess.
const UNSCORED_VERIFICATION_RATE = 0.5;
// Also what a scored channel with a null p50 gets: sends but no verifications in the
// window means no measured time-to-verify, which must not read as a fast one.
const UNSCORED_P50_MS = Number.POSITIVE_INFINITY;

export type RankByScoreResult = Readonly<{
  candidates: readonly CandidateChannel[];
  decisionLog: readonly DecisionLogEntry[];
}>;

/** R3.7/R3.8: stage ③ — orders by verification rate (never delivery rate; the caller
 * scopes `channelScores` to the routing input's country before this ever runs),
 * tie-broken on p50 time-to-verify. Scores are read here, never computed here — that's
 * the score-recompute job's job (R3.8). */
export function rankByScore(
  candidates: readonly CandidateChannel[],
  channelScores: readonly ChannelScoreRecord[],
): RankByScoreResult {
  const byChannel = new Map(channelScores.map((score) => [score.channel, score]));

  const ranked = [...candidates].sort((a, b) => {
    const scoreA = byChannel.get(a.channel);
    const scoreB = byChannel.get(b.channel);
    const rateA = scoreA?.verificationRate ?? UNSCORED_VERIFICATION_RATE;
    const rateB = scoreB?.verificationRate ?? UNSCORED_VERIFICATION_RATE;
    if (rateA !== rateB) return rateB - rateA;
    const p50A = scoreA?.p50Ms ?? UNSCORED_P50_MS;
    const p50B = scoreB?.p50Ms ?? UNSCORED_P50_MS;
    return p50A - p50B;
  });

  const decisionLog: DecisionLogEntry[] =
    ranked.map((c) => c.channel).join() === candidates.map((c) => c.channel).join()
      ? []
      : [
          {
            stage: "score_rank",
            action: "reordered",
            reason: `ranked by verification rate: [${ranked.map((c) => c.channel).join(", ")}]`,
          },
        ];

  return { candidates: ranked, decisionLog };
}
