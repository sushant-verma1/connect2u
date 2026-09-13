const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
});

export function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  return dateFormatter.format(new Date(iso));
}

export function formatDurationMs(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** G8: rate_micros' own unit — divide by 1e6 for the currency it's denominated in
 * (INR, PROJECT.md's rate table). */
export function formatCostMicros(micros: number | null): string {
  if (micros === null) return "unknown (unpriced corridor)";
  return `₹${(micros / 1_000_000).toFixed(4)}`;
}
