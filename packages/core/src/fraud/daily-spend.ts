// R7.5/G8: today's total spend, split into what's actually known and how many sends
// used an unpriced corridor (`cost_micros_at_send IS NULL`) — the caller (packages/db's
// sumTodaySpendForAccount) does the aggregation; this stays pure.
export type SpendSummary = Readonly<{
  knownMicros: number;
  unpricedCount: number;
}>;

// ponytail: a fixed conservative stand-in, not a measured number — chosen as the
// single most expensive corridor this rate card knows about today (Meta's WhatsApp
// international rate, PROJECT.md's cost table), so every unpriced send is assumed to
// cost at least as much as the priciest lane that exists, never less. This is the
// explicit answer to "how does the ceiling treat unknown cost": never silently as 0,
// which would make the ceiling itself the thing toll fraud routes around by using
// corridors nobody's priced yet. Ceiling: replace with a live
// `MAX(rate_micros)` query once every corridor has a real provider_rates row and the
// fixed constant risks drifting from what "most expensive" actually means.
export const UNPRICED_ATTEMPT_ASSUMED_COST_MICROS = 2_000_000;

/** Never trusts a NULL cost as free — see the constant's comment above. */
export function estimateTodaySpendMicros(summary: SpendSummary): number {
  return summary.knownMicros + summary.unpricedCount * UNPRICED_ATTEMPT_ASSUMED_COST_MICROS;
}

/** R7.5: `capMicros` of `null` means the account has no configured ceiling — not
 * enforced, not defaulted to some assumed value. */
export function exceedsDailySpendCeiling(summary: SpendSummary, capMicros: number | null): boolean {
  if (capMicros === null) return false;
  return estimateTodaySpendMicros(summary) > capMicros;
}
