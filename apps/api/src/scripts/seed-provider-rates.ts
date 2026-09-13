import { createPgClient } from "@otp-router/db/client";
import { upsertProviderRate } from "@otp-router/db/repositories/provider-rates";
import { loadConfig } from "../config.js";

/**
 * G8: Meta's WhatsApp authentication rate card, effective 1 July 2026 (PROJECT.md) —
 * ₹0.115 India domestic, ₹1.75–2.50 international (midpoint used below). SMS rows are
 * representative placeholders (real Indian SMS is out of reach per PROJECT.md's DLT
 * constraint) — enough for `cost_micros_at_send` to have something to look up.
 *
 * Run with `pnpm --filter @otp-router/api seed:rates`.
 */
const EFFECTIVE_FROM = new Date("2026-07-01T00:00:00Z");

const RATE_CARD = [
  { provider: "meta", channel: "whatsapp", country: "IN", rateMicros: 115_000 },
  { provider: "meta", channel: "whatsapp", country: "INTL", rateMicros: 2_000_000 },
  { provider: "generic_sms", channel: "sms", country: "IN", rateMicros: 150_000 },
  { provider: "generic_sms", channel: "sms", country: "INTL", rateMicros: 3_500_000 },
] as const;

const config = loadConfig();
const pg = createPgClient(config.databaseUrl);

// Reference data with deterministic IDs (`rate_<effectiveFrom>_<index>`) — re-running
// this script (README's local setup and deploy sequence both call for it) must be a
// no-op on the second run, not a primary-key violation.
for (const [i, rate] of RATE_CARD.entries()) {
  await upsertProviderRate(pg, {
    id: `rate_${EFFECTIVE_FROM.getTime()}_${i}`,
    messageType: "authentication",
    currency: "INR",
    effectiveFrom: EFFECTIVE_FROM,
    ...rate,
  });
}

await pg.end();

console.log(
  `Seeded ${RATE_CARD.length} provider_rates rows effective ${EFFECTIVE_FROM.toISOString()}`,
);
