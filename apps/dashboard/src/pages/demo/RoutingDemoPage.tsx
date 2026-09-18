import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";
import {
  ApiError,
  beginAdaptiveAttempt,
  fetchDemoRoutingReport,
  startDemoRoutingSession,
  submitCalibrationChoice,
  verifyAdaptiveChannel,
} from "../../lib/api";
import type {
  DecisionLogEntry,
  DemoAttempt,
  DemoChannel,
  DemoPendingAdaptive,
  DemoSessionSummary,
  Trace,
} from "../../lib/types";
import { RoutingDecisionCard } from "../trace/RoutingDecisionCard";
import { AttemptCountdown } from "./AttemptCountdown";
import { CalibrationForm } from "./CalibrationForm";
import { DemoReportCard } from "./DemoReportCard";

const CHANNEL_LABEL: Record<DemoChannel, string> = { whatsapp: "WhatsApp", sms: "SMS" };

/** RoutingDecisionCard (pages/trace) expects `Trace["routing_decision"]` — both a
 * pending attempt's decision and a resolved one's carry the same `decision_log` shape
 * (the real router's DecisionLogEntry[]), so this is a reshape, not a second render of
 * the decision log. */
function toRoutingDecision(
  decisionLog: readonly DecisionLogEntry[],
  chosenChannel: DemoChannel,
): Trace["routing_decision"] {
  const considered = decisionLog
    .filter((entry) => entry.stage === "match_policy" && entry.action === "considered")
    .map((entry) => entry.channel)
    .filter((channel): channel is string => channel !== undefined);
  return { considered, chosen_channel: chosenChannel, decision_log: [...decisionLog] };
}

export function RoutingDemoPage() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [summary, setSummary] = useState<DemoSessionSummary | null>(null);
  const [calibrationSelections, setCalibrationSelections] = useState<(DemoChannel | null)[]>([
    null,
    null,
    null,
  ]);
  const [pending, setPending] = useState<DemoPendingAdaptive | null>(null);
  const [resolvedAttempt, setResolvedAttempt] = useState<DemoAttempt | null>(null);

  const startMutation = useMutation({
    mutationFn: startDemoRoutingSession,
    onSuccess: (data) => {
      setSessionId(data.session_id);
      setSummary(data);
      setCalibrationSelections([null, null, null]);
      setPending(null);
      setResolvedAttempt(null);
    },
  });

  // §1: all 3 calibration choices are sent together on submit, in order — three
  // sequential POSTs to the existing per-attempt endpoint (the backend still enforces
  // one choice per call and the calibration-phase boundary independently).
  const calibrationSubmitMutation = useMutation({
    mutationFn: async () => {
      const channels = calibrationSelections;
      if (channels.some((c) => c === null)) {
        throw new Error("all 3 calibration OTPs need a channel selected");
      }
      let last;
      for (const channel of channels as DemoChannel[]) {
        last = await submitCalibrationChoice(sessionId as string, channel);
      }
      return last!;
    },
    onSuccess: (data) => {
      setSummary(data);
    },
  });

  const beginMutation = useMutation({
    mutationFn: () => beginAdaptiveAttempt(sessionId as string),
    onSuccess: (data) => {
      setSummary(data);
      setPending(data.pending);
      setResolvedAttempt(null);
    },
  });

  const verifyMutation = useMutation({
    mutationFn: (channel: DemoChannel) => verifyAdaptiveChannel(sessionId as string, channel),
    onSuccess: (data) => {
      setSummary(data);
      setResolvedAttempt(data.attempt);
      setPending(null);
    },
  });

  const reportQuery = useQuery({
    queryKey: ["demo-routing-report", sessionId],
    queryFn: () => fetchDemoRoutingReport(sessionId as string),
    enabled: sessionId !== null && summary?.phase === "complete" && !resolvedAttempt,
  });

  const busy =
    startMutation.isPending ||
    calibrationSubmitMutation.isPending ||
    beginMutation.isPending ||
    verifyMutation.isPending;
  const rateLimited = (err: unknown) => err instanceof ApiError && err.status === 429;
  const actionError =
    calibrationSubmitMutation.error ?? beginMutation.error ?? verifyMutation.error ?? null;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Connect2U Adaptive Routing Demo</h1>
        <p className="mt-1 text-sm text-slate-600">
          Choose your channel for the first 3 OTPs. Then Connect2U takes over: it picks the channel
          for each of the next 10, and you verify through whichever one it makes available.
        </p>
      </div>
      <Badge variant="info">Delivery simulated — no real SMS or WhatsApp message is sent.</Badge>

      {!sessionId && (
        <Card>
          <CardContent className="space-y-3">
            <p className="text-sm text-slate-600">
              13 simulated OTPs: 3 you route yourself, then 10 the router picks — reusing the same
              routing engine a real verification uses.
            </p>
            <button
              onClick={() => startMutation.mutate()}
              disabled={startMutation.isPending}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {startMutation.isPending ? "Starting…" : "Start demo"}
            </button>
            {startMutation.isError && (
              <p className="text-sm text-rose-600">
                {rateLimited(startMutation.error)
                  ? "The demo is busy right now — wait a moment and try again."
                  : `Failed to start: ${startMutation.error.message}`}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {sessionId && summary?.phase === "calibration" && (
        <CalibrationForm
          selections={calibrationSelections}
          onSelect={(index, channel) =>
            setCalibrationSelections((prev) => prev.map((c, i) => (i === index ? channel : c)))
          }
          onSubmit={() => calibrationSubmitMutation.mutate()}
          submitting={calibrationSubmitMutation.isPending}
          error={
            calibrationSubmitMutation.isError
              ? rateLimited(calibrationSubmitMutation.error)
                ? "The demo is busy right now — wait a moment and try again."
                : calibrationSubmitMutation.error.message
              : null
          }
        />
      )}

      {sessionId &&
        summary &&
        (summary.phase === "adaptive" || (summary.phase === "complete" && resolvedAttempt)) && (
          <Card>
            <CardHeader className="flex items-center justify-between">
              <CardTitle>Adaptive Test</CardTitle>
              <span className="text-xs text-slate-500">
                {pending?.attempt ?? resolvedAttempt?.attempt ?? summary.adaptive.completed} / 10
              </span>
            </CardHeader>
            <CardContent className="space-y-4">
              {!pending && !resolvedAttempt && (
                <div>
                  <p className="mb-3 text-sm text-slate-600">
                    Connect2U will pick the channel for this OTP.
                  </p>
                  <button
                    onClick={() => beginMutation.mutate()}
                    disabled={busy}
                    className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                  >
                    {beginMutation.isPending
                      ? "Routing…"
                      : `Send OTP ${summary.adaptive.completed + 1} / 10`}
                  </button>
                </div>
              )}

              {actionError && (
                <p className="text-sm text-rose-600">
                  {rateLimited(actionError)
                    ? "The demo is busy right now — wait a moment and try again."
                    : `Something went wrong: ${actionError.message}`}
                </p>
              )}

              {pending && (
                <>
                  <AttemptCountdown
                    pending={pending}
                    onVerify={(channel) => verifyMutation.mutate(channel)}
                    verifying={verifyMutation.isPending}
                  />
                  <RoutingDecisionCard
                    routingDecision={toRoutingDecision(
                      pending.decision_log,
                      pending.routed_channel,
                    )}
                  />
                </>
              )}

              {resolvedAttempt && (
                <div className="space-y-4 border-t border-slate-100 pt-4">
                  <p className="text-sm text-slate-700">
                    ✅ Verified via {CHANNEL_LABEL[resolvedAttempt.final_channel]}
                    {resolvedAttempt.fallback_used ? " (fallback)" : ""}
                  </p>
                  <RoutingDecisionCard
                    routingDecision={toRoutingDecision(
                      resolvedAttempt.decision_log,
                      resolvedAttempt.routed_channel,
                    )}
                  />
                  <button
                    onClick={() => setResolvedAttempt(null)}
                    className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
                  >
                    {summary.phase === "complete" ? "View report" : "Next OTP"}
                  </button>
                </div>
              )}
            </CardContent>
          </Card>
        )}

      {summary?.phase === "complete" && !resolvedAttempt && reportQuery.data && (
        <DemoReportCard report={reportQuery.data} />
      )}
      {summary?.phase === "complete" && !resolvedAttempt && reportQuery.isLoading && (
        <Card>
          <CardContent className="text-sm text-slate-600">Building report…</CardContent>
        </Card>
      )}
    </div>
  );
}
