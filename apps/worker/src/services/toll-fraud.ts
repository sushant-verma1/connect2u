import type { Logger } from "pino";
import type { PgClient } from "@otp-router/db/client";
import { tripAccountToManualReview } from "@otp-router/db/repositories/accounts";
import { sumTodaySpendForAccount } from "@otp-router/db/repositories/delivery-attempts";
import { exceedsDailySpendCeiling } from "@otp-router/core/fraud/daily-spend";

/**
 * R7.5: called after every successful send once its cost is written
 * (`markDeliveryAttemptSent`), never before — the ceiling is evaluated against spend
 * that has actually happened, not spend this send is about to add (this send's own
 * cost is already included in `sumTodaySpendForAccount` by the time this runs).
 * `tripAccountToManualReview`'s conditional UPDATE means calling this concurrently
 * from several in-flight deliveries for the same account is safe — only the first to
 * land actually flips the row, every other call's UPDATE matches zero rows.
 */
export async function enforceDailySpendCeiling(
  pg: PgClient,
  params: { accountId: string; dailyCostCapMicros: number | null },
  logger: Logger,
): Promise<void> {
  if (params.dailyCostCapMicros === null) return;

  const summary = await sumTodaySpendForAccount(pg, params.accountId);
  if (!exceedsDailySpendCeiling(summary, params.dailyCostCapMicros)) return;

  const tripped = await tripAccountToManualReview(pg, params.accountId);
  if (tripped) {
    logger.warn(
      { accountId: params.accountId, ...summary, capMicros: params.dailyCostCapMicros },
      "R7.5 daily spend ceiling exceeded — account moved to manual_review, sends halted",
    );
  }
}
