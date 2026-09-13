import { Badge } from "../../components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { formatDurationMs, formatTimestamp } from "../../lib/format";
import type { Trace } from "../../lib/types";
import { VerificationStatusBadge } from "./statusBadges";

export function VerificationSummaryCard({ trace }: { trace: Trace }) {
  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <CardTitle className="font-mono text-sm">{trace.verification_id}</CardTitle>
        <VerificationStatusBadge status={trace.status} />
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-slate-400">Channel chain</dt>
            <dd className="mt-0.5 flex flex-wrap gap-1">
              {trace.channel_chain.map((channel) => (
                <Badge
                  key={channel}
                  variant={channel === trace.verified_channel ? "success" : "neutral"}
                >
                  {channel}
                </Badge>
              ))}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-400">Attempts used</dt>
            <dd className="mt-0.5 font-medium text-slate-800">
              {trace.attempts_used} / {trace.max_attempts}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-400">Created</dt>
            <dd className="mt-0.5">{formatTimestamp(trace.created_at)}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-400">Expires</dt>
            <dd className="mt-0.5">{formatTimestamp(trace.expires_at)}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-400">Verified at</dt>
            <dd className="mt-0.5">{formatTimestamp(trace.verified_at)}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-400">Verified channel</dt>
            <dd className="mt-0.5">{trace.verified_channel ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-400">Time to verify</dt>
            <dd className="mt-0.5">{formatDurationMs(trace.time_to_verify_ms)}</dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}
