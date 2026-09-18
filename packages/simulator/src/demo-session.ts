import { CHANNELS, type Channel } from "@otp-router/core/fallback/channel-chain";
import { buildRoutingPlan } from "@otp-router/core/routing/build-plan";
import type {
  ChannelScoreRecord,
  DecisionLogEntry,
  RoutingInput,
} from "@otp-router/core/routing/types";
import type { RoutingPolicy } from "@otp-router/core/routing/policy";

/**
 * The public /demo/routing dashboard page's engine (apps/api/src/routes/demo.ts). Pure
 * -- no DB, no queue, no `Date.now()` of its own (I1 applies to packages/core only, but
 * the same discipline is what keeps this file testable: every caller passes `nowMs`
 * in, nothing in here reads the clock). There is exactly one real person driving a
 * session -- calibration just records which channel they picked (ponytail: no
 * population/provider failure simulation here; that machinery in ./population.ts and
 * ./score-tracker.ts stands in for a fleet of synthetic recipients, which stopped
 * applying the moment this became one real visitor clicking real buttons -- add it
 * back only if the demo ever needs to simulate calibration failing outright), and
 * adaptive attempts are resolved by whichever channel button they actually click,
 * within the window this module tracks server-side. `buildRoutingPlan` is the exact
 * function `/v1/verification/start` calls; this file never reimplements routing, only
 * how the demo's own win-share statistics get turned into `ChannelScoreRecord[]` for
 * it (§5/§6).
 */
export const DEMO_CALIBRATION_ATTEMPTS = 3;
export const DEMO_ADAPTIVE_ATTEMPTS = 10;

export type DemoPhase = "calibration" | "adaptive" | "complete";

export type DemoChannelOutcome = Readonly<{
  channel: Channel;
  outcome: "verified" | "timeout";
  latencyMs: number;
}>;

export type DemoAttempt = Readonly<{
  attempt: number; // 1-based, within its own phase
  phase: "calibration" | "adaptive";
  routedChannel: Channel;
  finalChannel: Channel;
  fallbackUsed: boolean;
  verified: true;
  timeoutMs: number;
  latencyMs: number;
  primary: DemoChannelOutcome;
  fallback: DemoChannelOutcome | null;
  decisionLog: readonly DecisionLogEntry[];
}>;

// The adaptive attempt the router has decided on but the visitor hasn't resolved yet --
// the only channel button that's actually clickable is whichever one `verifyAdaptiveChannel`
// would currently accept. `priorityDeadlineMs`/`startedAtMs` are absolute epoch ms, set
// once by the caller's `nowMs` at `beginAdaptiveAttempt` time, never recomputed from a
// clock read inside this module.
export type PendingAdaptiveAttempt = Readonly<{
  attempt: number; // 1-based, within the adaptive phase
  routedChannel: Channel;
  fallbackChannel: Channel | null;
  reason: string;
  decisionLog: readonly DecisionLogEntry[];
  timeoutMs: number;
  startedAtMs: number;
  priorityDeadlineMs: number;
}>;

export type DemoSessionState = Readonly<{
  calibrationChoices: readonly Channel[]; // 0..DEMO_CALIBRATION_ATTEMPTS, in order
  adaptiveResults: readonly DemoAttempt[]; // committed adaptive attempts, in order
  lastVerifiedChannel: Channel | null; // tie-break signal (§6)
  pendingAdaptive: PendingAdaptiveAttempt | null;
}>;

export function startSession(): DemoSessionState {
  return {
    calibrationChoices: [],
    adaptiveResults: [],
    lastVerifiedChannel: null,
    pendingAdaptive: null,
  };
}

export function sessionPhase(state: DemoSessionState): DemoPhase {
  if (state.calibrationChoices.length < DEMO_CALIBRATION_ATTEMPTS) return "calibration";
  if (state.adaptiveResults.length < DEMO_ADAPTIVE_ATTEMPTS) return "adaptive";
  return "complete";
}

// Fixed, not wall-clock -- with capabilityRecords always [] and no score-decay
// calculation ever reading it, a constant keeps calibration's routing input pure
// without a VirtualClock's bookkeeping for what is at most 3 steps.
const DEMO_NOW = new Date(0);

/**
 * One calibration OTP. `forcedChannel` restricts the router to that one channel via
 * `requestedChannels` -- the real match-policy stage, not a bypass of it -- so
 * calibration still produces a real decision log, it just isn't free to choose. The
 * visitor is the only "recipient" in this demo and always receives it (§1 never
 * describes a calibration failure state), so this always resolves as verified via the
 * chosen channel.
 */
function calibrationAttempt(
  attemptNumber: number,
  policy: RoutingPolicy,
  forcedChannel: Channel,
): DemoAttempt {
  const input: RoutingInput = {
    accountId: "acct_demo",
    phoneHash: `demo_calibration_${attemptNumber}`,
    country: "AU",
    prefix: "+61",
    metadata: {},
    requestedChannels: [forcedChannel],
    now: DEMO_NOW,
  };

  const plan = buildRoutingPlan(policy, input, [], [], []);
  const routedChannel = plan.orderedChannels[0];
  if (!routedChannel) {
    throw new Error("demo routing policy produced no channel -- policy misconfigured");
  }
  const timeoutMs = plan.timeouts[routedChannel] ?? 5000;
  const primary: DemoChannelOutcome = { channel: routedChannel, outcome: "verified", latencyMs: 0 };

  return {
    attempt: attemptNumber,
    phase: "calibration",
    routedChannel,
    finalChannel: routedChannel,
    fallbackUsed: false,
    verified: true,
    timeoutMs,
    latencyMs: 0,
    primary,
    fallback: null,
    decisionLog: plan.decisionLog,
  };
}

function replayCalibration(policy: RoutingPolicy, state: DemoSessionState): readonly DemoAttempt[] {
  return state.calibrationChoices
    .map((channel, i) => (channel ? calibrationAttempt(i + 1, policy, channel) : null))
    .filter((attempt): attempt is DemoAttempt => attempt !== null);
}

export function stepCalibration(
  policy: RoutingPolicy,
  state: DemoSessionState,
  channel: Channel,
): { state: DemoSessionState; attempt: DemoAttempt } {
  if (sessionPhase(state) !== "calibration") {
    throw new Error("session is not in calibration phase");
  }
  const nextChoices = [...state.calibrationChoices, channel];
  const attempts = replayCalibration(policy, { ...state, calibrationChoices: nextChoices });
  const attempt = attempts[attempts.length - 1];
  if (!attempt) throw new Error("unreachable: replay produced no attempts");

  const nextState: DemoSessionState = {
    ...state,
    calibrationChoices: nextChoices,
    lastVerifiedChannel: attempt.finalChannel,
  };
  return { state: nextState, attempt };
}

/**
 * §5/§6: the router's decision for the next adaptive attempt. Statistics are each
 * channel's *win share* -- how many of the attempts so far (calibration + adaptive)
 * it was the one that actually got verified through, out of every attempt made -- fed
 * into `buildRoutingPlan`/`rankByScore` as `ChannelScoreRecord[]` exactly the way a
 * real score-recompute job would, just with this demo's own statistic instead of
 * production's per-channel verification rate (which a no-failure-state adaptive phase
 * would leave permanently tied at 100%, defeating the point of the demo). Ties are
 * broken on the most recently verified channel (§6), not on `rankByScore`'s own p50
 * tie-break, which this demo has no meaningful latency signal to feed.
 */
export function decideNextAdaptive(
  policy: RoutingPolicy,
  state: DemoSessionState,
): {
  routedChannel: Channel;
  fallbackChannel: Channel | null;
  reason: string;
  decisionLog: readonly DecisionLogEntry[];
  timeoutMs: number;
} {
  const calibrationAttempts = replayCalibration(policy, state);

  const wins: Record<Channel, number> = { whatsapp: 0, sms: 0 };
  let total = 0;
  for (const attempt of [...calibrationAttempts, ...state.adaptiveResults]) {
    total += 1;
    wins[attempt.finalChannel] += 1;
  }

  const channelScores: readonly ChannelScoreRecord[] = CHANNELS.map((channel) => ({
    channel,
    verificationRate: total > 0 ? wins[channel] / total : 0.5,
    p50Ms: null,
  }));

  const input: RoutingInput = {
    accountId: "acct_demo",
    phoneHash: `demo_adaptive_${state.adaptiveResults.length + 1}`,
    country: "AU",
    prefix: "+61",
    metadata: {},
    now: DEMO_NOW,
  };
  const plan = buildRoutingPlan(policy, input, [], channelScores, []);
  let ordered = [...plan.orderedChannels];

  const rateOf = (channel: Channel): number =>
    channelScores.find((s) => s.channel === channel)?.verificationRate ?? 0.5;
  const [first, second] = ordered;
  const tied = first !== undefined && second !== undefined && rateOf(first) === rateOf(second);
  if (first !== undefined && second !== undefined && tied && state.lastVerifiedChannel === second) {
    ordered = [second, first];
  }

  const routedChannel = ordered[0];
  if (!routedChannel) {
    throw new Error("demo routing policy produced no channel -- policy misconfigured");
  }
  const fallbackChannel = ordered[1] ?? null;
  const timeoutMs = plan.timeouts[routedChannel] ?? 5000;

  const label = (channel: Channel): string => (channel === "whatsapp" ? "WhatsApp" : "SMS");
  const reason =
    tied && fallbackChannel
      ? `Both channels have the same verified rate (${wins[routedChannel]}/${total}), so the recently verified channel was prioritized.`
      : `${label(routedChannel)} was prioritized because its verified rate is ${wins[routedChannel]}/${total}.`;

  return { routedChannel, fallbackChannel, reason, decisionLog: plan.decisionLog, timeoutMs };
}

/**
 * §9/§10 step 1-4: computes the routing decision for the next adaptive attempt and
 * parks it as `pendingAdaptive` -- nothing is resolved yet, this is the server
 * committing to "here is the one channel you can currently verify through."
 */
export function beginAdaptiveAttempt(
  policy: RoutingPolicy,
  state: DemoSessionState,
  nowMs: number,
): { state: DemoSessionState; pending: PendingAdaptiveAttempt } {
  if (sessionPhase(state) !== "adaptive") {
    throw new Error("session is not in adaptive phase");
  }
  if (state.pendingAdaptive) {
    throw new Error("an adaptive attempt is already pending -- resolve it before starting another");
  }

  const decision = decideNextAdaptive(policy, state);
  const pending: PendingAdaptiveAttempt = {
    attempt: state.adaptiveResults.length + 1,
    routedChannel: decision.routedChannel,
    fallbackChannel: decision.fallbackChannel,
    reason: decision.reason,
    decisionLog: decision.decisionLog,
    timeoutMs: decision.timeoutMs,
    startedAtMs: nowMs,
    priorityDeadlineMs: nowMs + decision.timeoutMs,
  };

  return { state: { ...state, pendingAdaptive: pending }, pending };
}

/**
 * §3/§4/§10 step 6-9: the only place an adaptive attempt is ever resolved. `channel`
 * must be the one the visitor is actually allowed to click right now -- the priority
 * channel before `priorityDeadlineMs`, the fallback channel at or after it (§13: this
 * check is the actual guarantee, the frontend disabling a button is only a UI
 * courtesy). Anything else throws, mapped to 409 by the route layer.
 */
export function verifyAdaptiveChannel(
  state: DemoSessionState,
  channel: Channel,
  nowMs: number,
): { state: DemoSessionState; attempt: DemoAttempt } {
  const pending = state.pendingAdaptive;
  if (sessionPhase(state) !== "adaptive" || !pending) {
    throw new Error("no adaptive attempt is pending");
  }

  const timedOut = nowMs >= pending.priorityDeadlineMs;
  let primary: DemoChannelOutcome;
  let fallback: DemoChannelOutcome | null;

  if (channel === pending.routedChannel && (!timedOut || pending.fallbackChannel === null)) {
    primary = {
      channel: pending.routedChannel,
      outcome: "verified",
      latencyMs: nowMs - pending.startedAtMs,
    };
    fallback = null;
  } else if (timedOut && pending.fallbackChannel !== null && channel === pending.fallbackChannel) {
    primary = { channel: pending.routedChannel, outcome: "timeout", latencyMs: pending.timeoutMs };
    fallback = {
      channel: pending.fallbackChannel,
      outcome: "verified",
      latencyMs: nowMs - pending.priorityDeadlineMs,
    };
  } else {
    throw new Error("that channel is not currently available for this attempt");
  }

  const attempt: DemoAttempt = {
    attempt: pending.attempt,
    phase: "adaptive",
    routedChannel: pending.routedChannel,
    finalChannel: channel,
    fallbackUsed: fallback !== null,
    verified: true,
    timeoutMs: pending.timeoutMs,
    latencyMs: fallback ? primary.latencyMs + fallback.latencyMs : primary.latencyMs,
    primary,
    fallback,
    decisionLog: pending.decisionLog,
  };

  const nextState: DemoSessionState = {
    ...state,
    adaptiveResults: [...state.adaptiveResults, attempt],
    pendingAdaptive: null,
    lastVerifiedChannel: channel,
  };
  return { state: nextState, attempt };
}

/** Full attempt history -- calibration replayed from `state.calibrationChoices`,
 * adaptive read straight from the (already resolved, real-interaction-driven) session
 * state. Used by the GET session route and the final report; never trusts a
 * client-supplied attempt list. */
export function replaySession(
  policy: RoutingPolicy,
  state: DemoSessionState,
): { attempts: readonly DemoAttempt[] } {
  return { attempts: [...replayCalibration(policy, state), ...state.adaptiveResults] };
}

export type DemoReport = Readonly<{
  calibration: readonly DemoAttempt[];
  adaptive: readonly DemoAttempt[];
  channelUsage: Readonly<Record<Channel, number>>;
  successRate: Readonly<Record<Channel, number>>;
  avgLatencyMs: Readonly<Record<Channel, number | null>>;
  fallbackCounts: Readonly<{ whatsappToSms: number; smsToWhatsapp: number }>;
  routingChanges: number;
  fallbackEvents: number;
  finalChannel: Channel;
  explanation: string;
}>;

/**
 * Analytics/report screen (acceptance #14/#15) -- computed over `adaptive` only.
 * Calibration observations fed the router (they're folded into every adaptive
 * decision) but are never counted as adaptive-phase evidence themselves.
 */
export function buildDemoReport(attempts: readonly DemoAttempt[]): DemoReport {
  const calibration = attempts.filter((a) => a.phase === "calibration");
  const adaptive = attempts.filter((a) => a.phase === "adaptive");

  const channelUsage: Record<Channel, number> = { whatsapp: 0, sms: 0 };
  for (const a of adaptive) channelUsage[a.routedChannel] += 1;

  // Every channel *tried* (primary or fallback) within the 10 adaptive attempts counts
  // as one send for that channel -- the same sends/verifications shape channel_scores
  // itself uses, just scoped to this session's 10 attempts instead of a 24h window.
  const trials: Record<Channel, { sends: number; verified: number; latencies: number[] }> = {
    whatsapp: { sends: 0, verified: 0, latencies: [] },
    sms: { sends: 0, verified: 0, latencies: [] },
  };
  const record = (outcome: DemoChannelOutcome): void => {
    const bucket = trials[outcome.channel];
    bucket.sends += 1;
    if (outcome.outcome === "verified") {
      bucket.verified += 1;
      bucket.latencies.push(outcome.latencyMs);
    }
  };
  for (const a of adaptive) {
    record(a.primary);
    if (a.fallback) record(a.fallback);
  }

  const successRate: Record<Channel, number> = {
    whatsapp: trials.whatsapp.sends > 0 ? trials.whatsapp.verified / trials.whatsapp.sends : 0,
    sms: trials.sms.sends > 0 ? trials.sms.verified / trials.sms.sends : 0,
  };
  const avg = (values: number[]): number | null =>
    values.length > 0 ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
  const avgLatencyMs: Record<Channel, number | null> = {
    whatsapp: avg(trials.whatsapp.latencies),
    sms: avg(trials.sms.latencies),
  };

  let whatsappToSms = 0;
  let smsToWhatsapp = 0;
  for (const a of adaptive) {
    if (!a.fallbackUsed || !a.fallback) continue;
    if (a.primary.channel === "whatsapp" && a.fallback.channel === "sms") whatsappToSms += 1;
    if (a.primary.channel === "sms" && a.fallback.channel === "whatsapp") smsToWhatsapp += 1;
  }

  let routingChanges = 0;
  for (let i = 1; i < adaptive.length; i++) {
    if (adaptive[i]?.routedChannel !== adaptive[i - 1]?.routedChannel) routingChanges += 1;
  }

  const fallbackEvents = adaptive.filter((a) => a.fallbackUsed).length;
  const finalChannel = adaptive[adaptive.length - 1]?.routedChannel ?? "whatsapp";

  return {
    calibration,
    adaptive,
    channelUsage,
    successRate,
    avgLatencyMs,
    fallbackCounts: { whatsappToSms, smsToWhatsapp },
    routingChanges,
    fallbackEvents,
    finalChannel,
    explanation:
      "Connect2U updated subsequent routing decisions using the observed outcomes from " +
      "this session. This demo's routing statistics are session-local and unsmoothed " +
      "(no minimum sample size, no rolling window), so they move faster across 10 " +
      "attempts than production's 24-hour, cross-account channel_scores would -- that's " +
      "what makes the routing change visible in a short demo, not a change to the " +
      "router itself.",
  };
}
