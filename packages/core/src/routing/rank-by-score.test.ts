import { describe, expect, it } from "vitest";
import { rankByScore } from "./rank-by-score.js";
import type { CandidateChannel, ChannelScoreRecord } from "./types.js";

const CANDIDATES: CandidateChannel[] = [
  { channel: "whatsapp", timeoutMs: 20_000 },
  { channel: "sms", timeoutMs: 30_000 },
];

describe("rankByScore", () => {
  it("orders by verification rate, not the input order", () => {
    const scores: ChannelScoreRecord[] = [
      { channel: "whatsapp", verificationRate: 0.6, p50Ms: 5000 },
      { channel: "sms", verificationRate: 0.9, p50Ms: 8000 },
    ];
    const result = rankByScore(CANDIDATES, scores);
    expect(result.candidates.map((c) => c.channel)).toEqual(["sms", "whatsapp"]);
  });

  it("ties break on p50 time-to-verify, faster first", () => {
    const scores: ChannelScoreRecord[] = [
      { channel: "whatsapp", verificationRate: 0.8, p50Ms: 9000 },
      { channel: "sms", verificationRate: 0.8, p50Ms: 4000 },
    ];
    const result = rankByScore(CANDIDATES, scores);
    expect(result.candidates.map((c) => c.channel)).toEqual(["sms", "whatsapp"]);
  });

  it("treats an unscored channel as an average performer, not a penalised one", () => {
    const scores: ChannelScoreRecord[] = [{ channel: "sms", verificationRate: 0.3, p50Ms: 4000 }];
    const result = rankByScore(CANDIDATES, scores);
    // whatsapp (unscored, 0.5 neutral) outranks sms's measured-but-poor 0.3.
    expect(result.candidates.map((c) => c.channel)).toEqual(["whatsapp", "sms"]);
  });

  it("logs nothing when the score-driven order matches the input order", () => {
    const result = rankByScore(CANDIDATES, []);
    expect(result.candidates.map((c) => c.channel)).toEqual(["whatsapp", "sms"]);
    expect(result.decisionLog).toEqual([]);
  });
});
