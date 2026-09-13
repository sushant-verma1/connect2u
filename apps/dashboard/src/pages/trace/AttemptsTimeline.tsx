import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";
import { formatCostMicros, formatTimestamp } from "../../lib/format";
import type { TraceAttempt } from "../../lib/types";
import { AttemptStatusBadge } from "./statusBadges";

const TIMESTAMP_FIELDS: { key: keyof TraceAttempt; label: string }[] = [
  { key: "sent_at", label: "Sent" },
  { key: "delivered_at", label: "Delivered" },
  { key: "failed_at", label: "Failed" },
  { key: "timeout_at", label: "Timed out" },
];

function WebhookEventRow({ event }: { event: TraceAttempt["webhook_events"][number] }) {
  return (
    <li className="flex items-center gap-2 text-xs text-slate-600">
      <Badge variant={event.event_type === "delivered" ? "success" : "danger"}>
        {event.event_type}
      </Badge>
      <span>{event.provider}</span>
      <span
        className={event.signature_valid === false ? "text-rose-600" : "text-slate-400"}
        title="signature_valid"
      >
        {event.signature_valid === null
          ? "no signature scheme"
          : event.signature_valid
            ? "signed ✓"
            : "invalid signature"}
      </span>
      <span className="ml-auto text-slate-400">{formatTimestamp(event.created_at)}</span>
    </li>
  );
}

function AttemptCard({ attempt, index }: { attempt: TraceAttempt; index: number }) {
  const timestamps = TIMESTAMP_FIELDS.map(({ key, label }) => ({
    label,
    value: attempt[key] as string | null,
  })).filter((t) => t.value !== null);

  return (
    <li className="relative">
      <span className="absolute -left-[1.45rem] top-1 flex h-6 w-6 items-center justify-center rounded-full bg-slate-900 text-[11px] font-semibold text-white">
        {index + 1}
      </span>
      <Card>
        <CardHeader className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CardTitle className="capitalize">{attempt.channel}</CardTitle>
            <AttemptStatusBadge status={attempt.status} />
          </div>
          <span className="text-xs text-slate-500">
            {formatCostMicros(attempt.cost_micros_at_send)}
          </span>
        </CardHeader>
        <CardContent className="space-y-3">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-slate-600 sm:grid-cols-4">
            {timestamps.map((t) => (
              <div key={t.label}>
                <dt className="text-slate-400">{t.label}</dt>
                <dd>{formatTimestamp(t.value)}</dd>
              </div>
            ))}
            {attempt.error_code && (
              <div>
                <dt className="text-slate-400">Error code</dt>
                <dd className="font-medium text-rose-600">{attempt.error_code}</dd>
              </div>
            )}
          </dl>

          {attempt.webhook_events.length > 0 && (
            <div className="border-t border-slate-100 pt-3">
              <p className="mb-1.5 text-xs font-medium text-slate-400">Webhook events</p>
              <ul className="space-y-1.5">
                {attempt.webhook_events.map((event, eventIndex) => (
                  <WebhookEventRow key={eventIndex} event={event} />
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>
    </li>
  );
}

/** R10.6: every attempt, every webhook — one card per delivery attempt, in the order
 * the fallback chain actually tried them, each paired with the webhook events that
 * resolved it (see apps/api/src/services/trace.ts for the join). */
export function AttemptsTimeline({ attempts }: { attempts: readonly TraceAttempt[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Delivery attempts</CardTitle>
      </CardHeader>
      <CardContent>
        {attempts.length === 0 ? (
          <p className="text-sm text-slate-500">No delivery attempts yet.</p>
        ) : (
          <ol className="relative space-y-4 border-l border-slate-200 pl-5">
            {attempts.map((attempt, index) => (
              <AttemptCard key={attempt.id} attempt={attempt} index={index} />
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
