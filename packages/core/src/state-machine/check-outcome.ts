export const CHECK_OUTCOMES = [
  "verified",
  "invalid_code",
  "expired",
  "already_verified",
  "attempts_exceeded",
  "not_found",
  "failed",
] as const;

export type CheckOutcome = (typeof CHECK_OUTCOMES)[number];

/**
 * R1.2.6 / ARCHITECTURE.md §3: maps a terminal verification state to the /check
 * response vocabulary. `pending` never reaches here — the caller only calls this
 * once it already knows the state is terminal.
 */
export function outcomeForTerminalStatus(
  status: "verified" | "expired" | "burned" | "failed",
): CheckOutcome {
  switch (status) {
    case "verified":
      return "already_verified";
    case "expired":
      return "expired";
    case "burned":
      return "attempts_exceeded";
    case "failed":
      return "failed";
  }
}
