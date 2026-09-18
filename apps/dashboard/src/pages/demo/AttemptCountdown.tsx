import { useEffect, useState } from "react";
import { Badge } from "../../components/ui/badge";
import type { DemoChannel, DemoPendingAdaptive } from "../../lib/types";

const CHANNEL_LABEL: Record<DemoChannel, string> = { whatsapp: "WhatsApp", sms: "SMS" };

/**
 * §2/§3/§4 of the adaptive interaction spec: the router already chose a channel for
 * this attempt (`pending`), and exactly one of `routed_channel`/`fallback_channel` is
 * ever clickable — never both, never a free choice. The countdown is derived purely
 * from `pending.priority_deadline_ms - Date.now()`; this component ticking down to 0
 * only flips which button *looks* clickable, it does not itself resolve anything — the
 * server independently re-checks the deadline when `onVerify` actually posts (§13),
 * so a stale/paused tab can't verify the priority channel late.
 */
export function AttemptCountdown({
  pending,
  onVerify,
  verifying,
}: {
  pending: DemoPendingAdaptive;
  onVerify: (channel: DemoChannel) => void;
  verifying: boolean;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 250);
    return () => clearInterval(id);
    // Re-arm the ticker whenever a new attempt is parked, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending.attempt]);

  const timedOut = nowMs >= pending.priority_deadline_ms;
  const secondsLeft = Math.max(0, Math.ceil((pending.priority_deadline_ms - nowMs) / 1000));
  const fallbackLabel = pending.fallback_channel ? CHANNEL_LABEL[pending.fallback_channel] : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-sm text-slate-600">
          Connect2U selected{" "}
          <span className="font-medium text-slate-900">
            {CHANNEL_LABEL[pending.routed_channel]}
          </span>
        </span>
        <Badge variant="info">Routed automatically</Badge>
      </div>

      {/* Decision visualization: priority channel on top, the 5s fallback timer in the
          middle, the fallback channel below it — only one of the two channel "cards" is
          ever active at once. */}
      <div className="flex flex-col items-center gap-2">
        <button
          type="button"
          disabled={verifying || timedOut}
          onClick={() => onVerify(pending.routed_channel)}
          className={
            timedOut
              ? "w-full max-w-xs rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-medium text-slate-400"
              : "w-full max-w-xs rounded-md bg-emerald-600 px-4 py-3 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          }
        >
          {CHANNEL_LABEL[pending.routed_channel]} {timedOut ? "🔒" : "✓ (verify now)"}
        </button>

        <span className="text-lg leading-none text-slate-300">↓</span>
        <p className="font-mono text-sm text-slate-600">
          {!timedOut
            ? `Fallback in ${secondsLeft}s`
            : `${CHANNEL_LABEL[pending.routed_channel]} timed out — falling back to ${fallbackLabel ?? "—"}`}
        </p>
        <span className="text-lg leading-none text-slate-300">↓</span>

        {pending.fallback_channel && (
          <button
            type="button"
            disabled={verifying || !timedOut}
            onClick={() => pending.fallback_channel && onVerify(pending.fallback_channel)}
            className={
              timedOut
                ? "w-full max-w-xs rounded-md bg-emerald-600 px-4 py-3 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                : "w-full max-w-xs rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-medium text-slate-400"
            }
          >
            {fallbackLabel} {timedOut ? "✓ (verify now)" : "🔒"}
          </button>
        )}
      </div>

      <p className="text-sm text-slate-600">{pending.reason}</p>
    </div>
  );
}
