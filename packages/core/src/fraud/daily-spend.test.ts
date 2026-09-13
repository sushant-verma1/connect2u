import { describe, expect, it } from "vitest";
import {
  UNPRICED_ATTEMPT_ASSUMED_COST_MICROS,
  estimateTodaySpendMicros,
  exceedsDailySpendCeiling,
} from "./daily-spend.js";

describe("estimateTodaySpendMicros", () => {
  it("sums known cost alone when every send was priced", () => {
    expect(estimateTodaySpendMicros({ knownMicros: 500_000, unpricedCount: 0 })).toBe(500_000);
  });

  it("never treats an unpriced send as free — adds the conservative constant per send", () => {
    const summary = { knownMicros: 100_000, unpricedCount: 2 };
    expect(estimateTodaySpendMicros(summary)).toBe(
      100_000 + 2 * UNPRICED_ATTEMPT_ASSUMED_COST_MICROS,
    );
  });
});

describe("exceedsDailySpendCeiling", () => {
  it("never enforces when the account has no configured cap", () => {
    expect(exceedsDailySpendCeiling({ knownMicros: 10_000_000, unpricedCount: 100 }, null)).toBe(
      false,
    );
  });

  it("trips once known spend alone crosses the cap", () => {
    expect(exceedsDailySpendCeiling({ knownMicros: 1_000_001, unpricedCount: 0 }, 1_000_000)).toBe(
      true,
    );
  });

  it("trips from unpriced volume alone, even with zero known spend — the case a naive SUM(cost_micros_at_send) would miss entirely", () => {
    expect(exceedsDailySpendCeiling({ knownMicros: 0, unpricedCount: 1 }, 1_000_000)).toBe(true);
  });

  it("does not trip when spend is comfortably under the cap", () => {
    expect(exceedsDailySpendCeiling({ knownMicros: 100_000, unpricedCount: 0 }, 1_000_000)).toBe(
      false,
    );
  });
});
