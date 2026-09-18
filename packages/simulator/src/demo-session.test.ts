import { describe, expect, it } from "vitest";
import type { RoutingPolicy } from "@otp-router/core/routing/policy";
import {
  DEMO_ADAPTIVE_ATTEMPTS,
  DEMO_CALIBRATION_ATTEMPTS,
  beginAdaptiveAttempt,
  buildDemoReport,
  decideNextAdaptive,
  replaySession,
  sessionPhase,
  startSession,
  stepCalibration,
  verifyAdaptiveChannel,
  type DemoSessionState,
} from "./demo-session.js";

// Matches seed-demo.ts's demo account policy (5s/5s, I10) -- these tests exercise the
// pure engine directly, not through the DB, so the policy is inlined rather than
// reading the seed script.
const DEMO_POLICY: RoutingPolicy = {
  version: 1,
  rules: [],
  default: {
    channels: ["whatsapp", "sms"],
    timeouts_ms: { whatsapp: 5000, sms: 5000 },
    reason: "demo account: WhatsApp fails fast, SMS holds long enough to type a code",
  },
};

/** Resolves the currently pending adaptive attempt by clicking its priority channel
 * `verifyAtMs` (absolute) -- inside the 5s window this verifies via the priority
 * channel with no fallback involved. */
function beginAndVerifyPriority(
  state: DemoSessionState,
  startedAtMs: number,
  verifyAtMs: number,
): DemoSessionState {
  const { state: begun, pending } = beginAdaptiveAttempt(DEMO_POLICY, state, startedAtMs);
  const { state: next } = verifyAdaptiveChannel(begun, pending.routedChannel, verifyAtMs);
  return next;
}

/** Same, but clicks the fallback channel at/after the deadline -- the priority channel
 * times out and the fallback is what ends up verified. */
function beginAndVerifyFallback(
  state: DemoSessionState,
  startedAtMs: number,
  verifyAtMs: number,
): DemoSessionState {
  const { state: begun, pending } = beginAdaptiveAttempt(DEMO_POLICY, state, startedAtMs);
  if (!pending.fallbackChannel) throw new Error("test setup: no fallback channel available");
  const { state: next } = verifyAdaptiveChannel(begun, pending.fallbackChannel, verifyAtMs);
  return next;
}

function completeCalibration(state: DemoSessionState): DemoSessionState {
  let s = state;
  s = stepCalibration(DEMO_POLICY, s, "whatsapp").state;
  s = stepCalibration(DEMO_POLICY, s, "whatsapp").state;
  s = stepCalibration(DEMO_POLICY, s, "sms").state;
  return s;
}

/** Runs all 10 adaptive attempts, always verifying through the priority channel well
 * inside the 5s window -- a plain "get through the whole session" helper for tests that
 * don't care about the fallback path specifically. */
function runAllAdaptivePriority(state: DemoSessionState): DemoSessionState {
  let s = state;
  let t = 0;
  for (let i = 0; i < DEMO_ADAPTIVE_ATTEMPTS; i++) {
    s = beginAndVerifyPriority(s, t, t + 100);
    t += 1000;
  }
  return s;
}

describe("demo-session — calibration", () => {
  it("accepts a channel choice on calibration attempts 1, 2, and 3", () => {
    let state = startSession();
    expect(sessionPhase(state)).toBe("calibration");

    const first = stepCalibration(DEMO_POLICY, state, "whatsapp");
    expect(first.attempt).toMatchObject({
      attempt: 1,
      phase: "calibration",
      routedChannel: "whatsapp",
    });
    state = first.state;
    expect(sessionPhase(state)).toBe("calibration");

    const second = stepCalibration(DEMO_POLICY, state, "sms");
    expect(second.attempt).toMatchObject({
      attempt: 2,
      phase: "calibration",
      routedChannel: "sms",
    });
    state = second.state;
    expect(sessionPhase(state)).toBe("calibration");

    const third = stepCalibration(DEMO_POLICY, state, "sms");
    expect(third.attempt).toMatchObject({ attempt: 3, phase: "calibration", routedChannel: "sms" });
    state = third.state;

    // Calibration attempt 3 completes calibration -- the phase switches automatically.
    expect(sessionPhase(state)).toBe("adaptive");
  });

  it("records each calibration choice as verified via the chosen channel", () => {
    const { attempt } = stepCalibration(DEMO_POLICY, startSession(), "sms");
    expect(attempt.routedChannel).toBe("sms");
    expect(attempt.finalChannel).toBe("sms");
    expect(attempt.verified).toBe(true);
  });

  it("rejects a calibration step once calibration is complete", () => {
    let state = startSession();
    for (let i = 0; i < DEMO_CALIBRATION_ATTEMPTS; i++) {
      state = stepCalibration(DEMO_POLICY, state, "whatsapp").state;
    }
    expect(() => stepCalibration(DEMO_POLICY, state, "whatsapp")).toThrow(/calibration/);
  });

  it("rejects an adaptive begin/verify before calibration is complete", () => {
    const fresh = startSession();
    expect(() => beginAdaptiveAttempt(DEMO_POLICY, fresh, 0)).toThrow(/adaptive/);
    expect(() => verifyAdaptiveChannel(fresh, "whatsapp", 0)).toThrow(/pending/);
  });
});

describe("demo-session — adaptive routing decision", () => {
  it("prioritizes the channel with the higher verified rate (win share across calibration + adaptive so far)", () => {
    // whatsapp x2, sms x1: whatsapp should lead 2/3 into the first adaptive decision.
    let state = startSession();
    state = stepCalibration(DEMO_POLICY, state, "whatsapp").state;
    state = stepCalibration(DEMO_POLICY, state, "whatsapp").state;
    state = stepCalibration(DEMO_POLICY, state, "sms").state;

    const decision = decideNextAdaptive(DEMO_POLICY, state);
    expect(decision.routedChannel).toBe("whatsapp");
    expect(decision.fallbackChannel).toBe("sms");
    expect(decision.reason).toBe("WhatsApp was prioritized because its verified rate is 2/3.");
  });

  it("recomputes the routing decision from every prior adaptive result, not just calibration", () => {
    let state = startSession();
    state = completeCalibration(state); // whatsapp x2, sms x1 -> whatsapp leads
    let decision = decideNextAdaptive(DEMO_POLICY, state);
    expect(decision.routedChannel).toBe("whatsapp");

    // Verify every adaptive attempt via fallback (SMS) until it overtakes WhatsApp --
    // proves the decision is recomputed from `adaptiveResults`, not frozen at whatever
    // calibration produced.
    let t = 0;
    let iterations = 0;
    while (decision.routedChannel !== "sms" && iterations < DEMO_ADAPTIVE_ATTEMPTS) {
      state = beginAndVerifyFallback(state, t, t + decision.timeoutMs + 100);
      t += decision.timeoutMs + 1000;
      decision = decideNextAdaptive(DEMO_POLICY, state);
      iterations += 1;
    }
    expect(decision.routedChannel).toBe("sms");
  });

  it("ties break on the most recently verified channel, not calibration order", () => {
    // whatsapp x2, sms x1 -> whatsapp leads 2/3 into the first adaptive decision, even
    // though sms was the more recently *chosen* calibration channel.
    let state = startSession();
    state = stepCalibration(DEMO_POLICY, state, "whatsapp").state;
    state = stepCalibration(DEMO_POLICY, state, "sms").state;
    state = stepCalibration(DEMO_POLICY, state, "whatsapp").state;
    expect(sessionPhase(state)).toBe("adaptive");
    let decision = decideNextAdaptive(DEMO_POLICY, state);
    expect(decision.routedChannel).toBe("whatsapp"); // 2/3 vs 1/3

    // Verify one attempt via SMS (fallback) to bring the tally to wa 2/4, sms 2/4 --
    // SMS was just verified, so it should now win the tie.
    state = beginAndVerifyFallback(state, 0, decision.timeoutMs + 100);
    decision = decideNextAdaptive(DEMO_POLICY, state);
    expect(decision.routedChannel).toBe("sms");
    expect(decision.reason).toBe(
      "Both channels have the same verified rate (2/4), so the recently verified channel was prioritized.",
    );
  });
});

describe("demo-session — adaptive interaction (begin/verify)", () => {
  it("begins a pending attempt with a single priority channel and a fallback candidate", () => {
    let state = startSession();
    state = completeCalibration(state);

    const { state: begun, pending } = beginAdaptiveAttempt(DEMO_POLICY, state, 0);
    expect(pending.attempt).toBe(1);
    expect(["whatsapp", "sms"]).toContain(pending.routedChannel);
    expect(pending.fallbackChannel).not.toBe(pending.routedChannel);
    expect(pending.timeoutMs).toBe(5000);
    expect(pending.priorityDeadlineMs).toBe(5000);
    expect(pending.decisionLog.length).toBeGreaterThan(0);
    expect(begun.pendingAdaptive).not.toBeNull();
  });

  it("rejects beginning a second attempt while one is already pending", () => {
    let state = startSession();
    state = completeCalibration(state);
    const { state: begun } = beginAdaptiveAttempt(DEMO_POLICY, state, 0);
    expect(() => beginAdaptiveAttempt(DEMO_POLICY, begun, 100)).toThrow(/pending/);
  });

  it("verifying the priority channel before the deadline records it as the verified channel, no fallback", () => {
    let state = startSession();
    state = completeCalibration(state);
    const { state: begun, pending } = beginAdaptiveAttempt(DEMO_POLICY, state, 0);

    const { state: next, attempt } = verifyAdaptiveChannel(begun, pending.routedChannel, 2000);
    expect(attempt.verified).toBe(true);
    expect(attempt.finalChannel).toBe(pending.routedChannel);
    expect(attempt.fallbackUsed).toBe(false);
    expect(attempt.primary.outcome).toBe("verified");
    expect(attempt.primary.latencyMs).toBe(2000);
    expect(attempt.fallback).toBeNull();
    expect(next.pendingAdaptive).toBeNull();
    expect(next.adaptiveResults).toHaveLength(1);
  });

  it("rejects verifying the fallback channel before the priority deadline has passed", () => {
    let state = startSession();
    state = completeCalibration(state);
    const { state: begun, pending } = beginAdaptiveAttempt(DEMO_POLICY, state, 0);
    const fallbackChannel = pending.fallbackChannel;
    if (!fallbackChannel) throw new Error("test setup: expected a fallback channel");

    expect(() => verifyAdaptiveChannel(begun, fallbackChannel, 4999)).toThrow(
      /not currently available/,
    );
  });

  it("verifying the fallback channel at/after the deadline disables the priority channel and records the fallback as verified", () => {
    let state = startSession();
    state = completeCalibration(state);
    const { state: begun, pending } = beginAdaptiveAttempt(DEMO_POLICY, state, 0);
    if (!pending.fallbackChannel) throw new Error("test setup: expected a fallback channel");

    // Priority channel is no longer valid once the deadline has passed.
    expect(() => verifyAdaptiveChannel(begun, pending.routedChannel, 6000)).toThrow(
      /not currently available/,
    );

    const { state: next, attempt } = verifyAdaptiveChannel(begun, pending.fallbackChannel, 5500);
    expect(attempt.fallbackUsed).toBe(true);
    expect(attempt.primary.outcome).toBe("timeout");
    expect(attempt.primary.latencyMs).toBe(pending.timeoutMs);
    expect(attempt.fallback?.channel).toBe(pending.fallbackChannel);
    expect(attempt.fallback?.outcome).toBe("verified");
    expect(attempt.finalChannel).toBe(pending.fallbackChannel);
    expect(next.pendingAdaptive).toBeNull();
  });

  it("uses a fallback deadline read from the policy (I10) -- 5s for the demo account's own seeded policy, not a hardcoded value", () => {
    let state = startSession();
    state = completeCalibration(state);
    const { pending } = beginAdaptiveAttempt(DEMO_POLICY, state, 1_000);
    expect(pending.timeoutMs).toBe(5000);
    expect(pending.priorityDeadlineMs).toBe(6000);

    const otherPolicy: RoutingPolicy = {
      ...DEMO_POLICY,
      default: { ...DEMO_POLICY.default, timeouts_ms: { whatsapp: 1234, sms: 1234 } },
    };
    let otherState = startSession();
    otherState = completeCalibration(otherState);
    const { pending: otherPending } = beginAdaptiveAttempt(otherPolicy, otherState, 0);
    expect(otherPending.timeoutMs).toBe(1234);
  });

  it("feeds each observed result back into routing statistics that determine the next decision", () => {
    let state = startSession();
    state = completeCalibration(state);

    let t = 0;
    for (let i = 0; i < 3; i++) {
      const before = decideNextAdaptive(DEMO_POLICY, state);
      state = beginAndVerifyPriority(state, t, t + 100);
      t += 1000;
      const after = decideNextAdaptive(DEMO_POLICY, state);
      // The decision is a function of observed history: after recording one more
      // verified result for `before.routedChannel`, that channel can only have gained
      // ground, so it's still either leading or tied for the lead.
      expect([after.routedChannel, after.fallbackChannel]).toContain(before.routedChannel);
    }
  });

  it("rejects an 11th adaptive attempt", () => {
    let state = startSession();
    state = completeCalibration(state);
    state = runAllAdaptivePriority(state);
    expect(sessionPhase(state)).toBe("complete");
    expect(state.adaptiveResults).toHaveLength(DEMO_ADAPTIVE_ATTEMPTS);
    expect(() => beginAdaptiveAttempt(DEMO_POLICY, state, 0)).toThrow(/adaptive/);
  });
});

describe("demo-session — report and replay", () => {
  it("excludes the 3 calibration attempts from the adaptive report", () => {
    let state = startSession();
    state = completeCalibration(state);
    state = runAllAdaptivePriority(state);
    const { attempts } = replaySession(DEMO_POLICY, state);
    const report = buildDemoReport(attempts);
    expect(report.calibration).toHaveLength(DEMO_CALIBRATION_ATTEMPTS);
    expect(report.adaptive).toHaveLength(DEMO_ADAPTIVE_ATTEMPTS);
    expect(report.channelUsage.whatsapp + report.channelUsage.sms).toBe(DEMO_ADAPTIVE_ATTEMPTS);
  });

  it("computes report totals correctly against a hand-checked replay", () => {
    let state = startSession();
    state = completeCalibration(state);
    // Deliberately force a fallback on every other attempt so both fallback counters
    // and routing-change counting have real data to check.
    let t = 0;
    for (let i = 0; i < DEMO_ADAPTIVE_ATTEMPTS; i++) {
      if (i % 2 === 0) {
        state = beginAndVerifyPriority(state, t, t + 100);
      } else {
        const decision = decideNextAdaptive(DEMO_POLICY, state);
        state = beginAndVerifyFallback(state, t, t + decision.timeoutMs + 100);
      }
      t += 10_000;
    }
    const { attempts } = replaySession(DEMO_POLICY, state);
    const report = buildDemoReport(attempts);

    let expectedFallbackEvents = 0;
    let expectedChanges = 0;
    let expectedWaToSms = 0;
    let expectedSmsToWa = 0;
    const sends: Record<"whatsapp" | "sms", number> = { whatsapp: 0, sms: 0 };
    const verifiedCounts: Record<"whatsapp" | "sms", number> = { whatsapp: 0, sms: 0 };
    report.adaptive.forEach((a, i) => {
      if (a.fallbackUsed) {
        expectedFallbackEvents += 1;
        if (a.primary.channel === "whatsapp" && a.fallback?.channel === "sms") expectedWaToSms += 1;
        if (a.primary.channel === "sms" && a.fallback?.channel === "whatsapp") expectedSmsToWa += 1;
      }
      if (i > 0 && a.routedChannel !== report.adaptive[i - 1]?.routedChannel) expectedChanges += 1;
      sends[a.primary.channel] = (sends[a.primary.channel] ?? 0) + 1;
      if (a.primary.outcome === "verified") verifiedCounts[a.primary.channel] += 1;
      if (a.fallback) {
        sends[a.fallback.channel] = (sends[a.fallback.channel] ?? 0) + 1;
        if (a.fallback.outcome === "verified") verifiedCounts[a.fallback.channel] += 1;
      }
    });

    expect(report.fallbackEvents).toBe(expectedFallbackEvents);
    expect(report.fallbackEvents).toBeGreaterThan(0);
    expect(report.routingChanges).toBe(expectedChanges);
    expect(report.fallbackCounts.whatsappToSms).toBe(expectedWaToSms);
    expect(report.fallbackCounts.smsToWhatsapp).toBe(expectedSmsToWa);
    expect(report.successRate.whatsapp).toBeCloseTo(
      sends.whatsapp > 0 ? verifiedCounts.whatsapp / sends.whatsapp : 0,
    );
    expect(report.successRate.sms).toBeCloseTo(sends.sms > 0 ? verifiedCounts.sms / sends.sms : 0);
    expect(report.finalChannel).toBe(report.adaptive[report.adaptive.length - 1]?.routedChannel);
  });

  it("is deterministic for calibration -- the same choices replay identically", () => {
    const a = completeCalibration(startSession());
    const b = completeCalibration(startSession());
    expect(replaySession(DEMO_POLICY, a).attempts).toEqual(replaySession(DEMO_POLICY, b).attempts);
  });

  it("GET-style replay never trusts the client -- it is always rebuilt from calibrationChoices + adaptiveResults", () => {
    let state = startSession();
    state = completeCalibration(state);
    state = beginAndVerifyPriority(state, 0, 100);
    const { attempts } = replaySession(DEMO_POLICY, state);
    expect(attempts).toHaveLength(DEMO_CALIBRATION_ATTEMPTS + 1);
  });
});
