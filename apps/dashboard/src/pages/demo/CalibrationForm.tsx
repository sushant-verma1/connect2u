import { Card, CardContent } from "../../components/ui/card";
import type { DemoChannel } from "../../lib/types";

const CHANNELS: readonly DemoChannel[] = ["whatsapp", "sms"];
const CHANNEL_LABEL: Record<DemoChannel, string> = { whatsapp: "WhatsApp", sms: "SMS" };

/**
 * §1 of the interaction spec: exactly 3 rows, one channel choice each, submitted
 * together — not one calibration POST per click the way the old per-attempt flow did.
 * `onSubmit` is disabled until every row has a selection; the backend enforces the same
 * thing independently (each `/calibration` call is still rejected once the session has
 * left the calibration phase), this is only the UI guarantee.
 */
export function CalibrationForm({
  selections,
  onSelect,
  onSubmit,
  submitting,
  error,
}: {
  selections: readonly (DemoChannel | null)[];
  onSelect: (index: number, channel: DemoChannel) => void;
  onSubmit: () => void;
  submitting: boolean;
  error?: string | null;
}) {
  const allSelected = selections.every((c) => c !== null);

  return (
    <Card>
      <CardContent className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Calibration</h2>
          <p className="mt-1 text-sm text-slate-600">
            Choose the channel you want to use for each of the first 3 OTPs.
          </p>
        </div>

        <div className="space-y-2">
          {selections.map((selected, index) => (
            <div
              key={index}
              className="flex items-center justify-between rounded-md border border-slate-200 px-3 py-2"
            >
              <span className="text-sm font-medium text-slate-700">OTP {index + 1}</span>
              <div className="flex gap-2">
                {CHANNELS.map((channel) => (
                  <button
                    key={channel}
                    type="button"
                    onClick={() => onSelect(index, channel)}
                    disabled={submitting}
                    className={
                      selected === channel
                        ? "rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                        : "rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                    }
                  >
                    {CHANNEL_LABEL[channel]}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        <button
          onClick={onSubmit}
          disabled={!allSelected || submitting}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {submitting ? "Submitting…" : "Submit Calibration"}
        </button>
        {error && <p className="text-sm text-rose-600">{error}</p>}
      </CardContent>
    </Card>
  );
}
