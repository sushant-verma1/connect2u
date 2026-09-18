import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";
import { formatDurationMs } from "../../lib/format";
import type { DemoChannel, DemoReport } from "../../lib/types";

const CHANNEL_LABEL: Record<DemoChannel, string> = { whatsapp: "WhatsApp", sms: "SMS" };

function Meter({ label, value }: { label: string; value: number }) {
  const pct = Math.round(value * 100);
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs text-slate-600">
        <span>{label}</span>
        <span className="font-medium text-slate-900">{pct}%</span>
      </div>
      <div className="h-2 rounded-full bg-slate-100">
        <div className="h-2 rounded-full bg-emerald-500" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/**
 * Acceptance #14/#15: built only from `report.adaptive` (the API never includes
 * calibration in these totals — see buildDemoReport in
 * packages/simulator/src/demo-session.ts) with calibration shown separately, below,
 * purely for context.
 */
export function DemoReportCard({ report }: { report: DemoReport }) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Adaptive routing report (10 attempts)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
              Channel usage
            </p>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                WhatsApp: <span className="font-medium">{report.channel_usage.whatsapp}</span>
              </div>
              <div>
                SMS: <span className="font-medium">{report.channel_usage.sms}</span>
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
              Verification success rate
            </p>
            <Meter label="WhatsApp" value={report.success_rate.whatsapp} />
            <Meter label="SMS" value={report.success_rate.sms} />
          </div>

          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
              Fallback events
            </p>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                WhatsApp → SMS:{" "}
                <span className="font-medium">{report.fallback_counts.whatsapp_to_sms}</span>
              </div>
              <div>
                SMS → WhatsApp:{" "}
                <span className="font-medium">{report.fallback_counts.sms_to_whatsapp}</span>
              </div>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              {report.fallback_events} fallback event{report.fallback_events === 1 ? "" : "s"} total
            </p>
          </div>

          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
              Average verification latency
            </p>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>WhatsApp: {formatDurationMs(report.avg_latency_ms.whatsapp)}</div>
              <div>SMS: {formatDurationMs(report.avg_latency_ms.sms)}</div>
            </div>
          </div>

          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
              Routing decisions over time
            </p>
            <div className="flex flex-wrap gap-1.5">
              {report.adaptive.map((attempt) => (
                <Badge
                  key={attempt.attempt}
                  variant={attempt.routed_channel === "whatsapp" ? "info" : "neutral"}
                >
                  {attempt.attempt}. {CHANNEL_LABEL[attempt.routed_channel]}
                </Badge>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              Routing changes: <span className="font-medium">{report.routing_changes}</span>
            </div>
            <div>
              Final routed channel:{" "}
              <span className="font-medium">{CHANNEL_LABEL[report.final_channel]}</span>
            </div>
          </div>

          <p className="border-t border-slate-100 pt-3 text-sm text-slate-600">
            {report.explanation}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Calibration (3 attempts — not included above)</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-1.5">
            {report.calibration.map((attempt) => (
              <Badge key={attempt.attempt} variant="neutral">
                {attempt.attempt}. {CHANNEL_LABEL[attempt.routed_channel]}
                {attempt.verified ? " ✓" : " ✗"}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
