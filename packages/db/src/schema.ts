import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const accountStatus = pgEnum("account_status", ["active", "manual_review", "suspended"]);

export const verificationStatus = pgEnum("verification_status", [
  "pending",
  "verified",
  "expired",
  "burned",
  "failed",
]);

export const deliveryStatus = pgEnum("delivery_status", [
  "queued",
  "sent",
  "delivered",
  "failed",
  "timed_out",
]);

// ARCHITECTURE.md §7. Only the three Phase 1 tables — routing_policies,
// channel_capability, channel_scores, provider_rates, webhook_events, and
// routing_decisions land with the phases that use them.
export const accounts = pgTable("accounts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  apiKeyHash: text("api_key_hash").notNull(),
  apiKeyPrefix: text("api_key_prefix").notNull().unique(),
  status: accountStatus("status").notNull().default("active"),
  dailyCostCapMicros: bigint("daily_cost_cap_micros", { mode: "number" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const verifications = pgTable(
  "verifications",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    // HMAC(phone, PHONE_HASH_PEPPER) — the join key for the future capability cache (R3.5).
    phoneHash: text("phone_hash").notNull(),
    // AES-256-GCM(phone, PHONE_ENCRYPTION_KEY) — plaintext exists only in memory during
    // the request; this is the sole at-rest place the real number is recoverable (R7.3).
    phoneEncrypted: text("phone_encrypted").notNull(),
    codeHmac: text("code_hmac").notNull(),
    // AES-256-GCM(code, CODE_ENCRYPTION_KEY) — R2.3: one code, shared across every
    // channel, never regenerated on fallback. This is what lets a later channel in the
    // chain resend the exact same code without holding the plaintext in a long-lived
    // process; `code_hmac` alone can't be reversed to get it back.
    codeEncrypted: text("code_encrypted").notNull(),
    // R4.7: the ordered channels this verification will try, capped at
    // MAX_FALLBACK_CHANNELS. Computed once at /start time by the routing pipeline
    // (packages/core/src/routing/build-plan.ts) and fixed for this verification's
    // lifetime — a later policy change never reaches into an in-flight verification.
    channelChain: jsonb("channel_chain").$type<string[]>().notNull().default([]),
    // R4.5: per-channel timeouts the same routing plan computed, keyed by channel —
    // never a global constant. Read by both the initial send (verification.ts) and
    // every fallback advance (apps/worker/src/services/fallback.ts).
    channelTimeoutsMs: jsonb("channel_timeouts_ms")
      .$type<Record<string, number>>()
      .notNull()
      .default({}),
    status: verificationStatus("status").notNull().default("pending"),
    attemptsUsed: integer("attempts_used").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifiedChannel: text("verified_channel"),
    timeToVerifyMs: integer("time_to_verify_ms"),
    metadataJson: jsonb("metadata_json").$type<Record<string, unknown>>().notNull().default({}),
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // R2.4 / ARCHITECTURE.md §7: partial index keeps lookups of in-flight verifications cheap.
    index("verifications_pending_idx")
      .on(table.status)
      .where(sql`${table.status} = 'pending'`),
    // R1.1.6/T4: a permanent binding, not a 24h one — R1.1.6 promises a replay works
    // "within 24h"; binding the key forever is a strictly safer superset of that (it
    // can only ever replay for *longer* than promised) and avoids the alternative of a
    // time-windowed uniqueness constraint racing a concurrent replay right at the
    // boundary. The 24h language describes the guaranteed minimum, not a hard expiry.
    uniqueIndex("verifications_account_idempotency_key_idx")
      .on(table.accountId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
  ],
);

export const deliveryAttempts = pgTable(
  "delivery_attempts",
  {
    id: text("id").primaryKey(),
    verificationId: text("verification_id")
      .notNull()
      .references(() => verifications.id),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    channel: text("channel").notNull(),
    provider: text("provider").notNull(),
    providerMessageId: text("provider_message_id"),
    status: deliveryStatus("status").notNull().default("queued"),
    errorCode: text("error_code"),
    // R3.7: the same two-bucket classification G8's cost lookup uses (packages/core's
    // classifyCountry), written once at send time — score-recompute (channel-scores.ts)
    // groups on this, not a live phone-number parse.
    country: text("country"),
    // I8 / G8: the rate applicable at send time, never looked up later.
    costMicrosAtSend: bigint("cost_micros_at_send", { mode: "number" }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    timeoutAt: timestamp("timeout_at", { withTimezone: true }),
  },
  (table) => [
    index("delivery_attempts_verification_id_idx").on(table.verificationId),
    // R6.2: a provider message ID identifies exactly one delivery attempt — this is how
    // an inbound webhook finds the row it's about, regardless of arrival order.
    uniqueIndex("delivery_attempts_provider_message_id_idx")
      .on(table.providerMessageId)
      .where(sql`${table.providerMessageId} is not null`),
  ],
);

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    providerMessageId: text("provider_message_id").notNull(),
    eventType: text("event_type").notNull(),
    payloadJson: jsonb("payload_json").$type<Record<string, unknown>>().notNull().default({}),
    // Null until Phase 4 adds real signature verification; simulated events have none.
    signatureValid: boolean("signature_valid"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // R6.2: the dedupe mechanism, a database unique constraint rather than an
    // application-level check. Keyed on (provider, provider_message_id) alone — R6.2
    // says a duplicate causes exactly one state transition per *message*, so the first
    // event a message receives is the one that's stored and acted on; any further event
    // for that message (regardless of type — a late `delivered` after a `failed` is the
    // canonical case, R4.8) is a duplicate at the DB level, not a second row.
    uniqueIndex("webhook_events_dedupe_idx").on(table.provider, table.providerMessageId),
  ],
);

// G8: the rate applicable at send time, versioned so a rate-card update never rewrites
// historical cost metrics — `cost_micros_at_send` freezes the value on the attempt row;
// this table is the source that value was looked up from.
export const providerRates = pgTable(
  "provider_rates",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    channel: text("channel").notNull(),
    // Two-bucket corridor, matching how Meta's own card is split: "IN" (domestic) vs
    // "INTL" (everything else) — see PROJECT.md's rate table.
    country: text("country").notNull(),
    messageType: text("message_type").notNull().default("authentication"),
    rateMicros: bigint("rate_micros", { mode: "number" }).notNull(),
    currency: text("currency").notNull().default("INR"),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("provider_rates_lookup_idx").on(
      table.provider,
      table.channel,
      table.country,
      table.messageType,
      table.effectiveFrom,
    ),
  ],
);

// R3.1/R3.3: declarative, versioned, per-account. Changing routing behaviour is a PUT,
// not a deploy — the API reads whichever row is `active` at request time.
export const routingPolicies = pgTable(
  "routing_policies",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    version: integer("version").notNull(),
    // Validated against packages/core/src/routing/policy.ts's Zod schema before it
    // ever reaches here — this column trusts the caller already checked shape.
    policyJson: jsonb("policy_json").$type<Record<string, unknown>>().notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("routing_policies_account_id_idx").on(table.accountId),
    // At most one active policy per account — the PUT handler deactivates the previous
    // one in the same transaction that activates the new one.
    uniqueIndex("routing_policies_account_active_idx")
      .on(table.accountId)
      .where(sql`${table.active} = true`),
  ],
);

// R3.5/R3.6: keyed on phone_hash — never plaintext. One row per (number, channel) this
// system has ever tried; confidence decays with age, updated on every delivery outcome.
export const channelCapability = pgTable(
  "channel_capability",
  {
    phoneHash: text("phone_hash").notNull(),
    channel: text("channel").notNull(),
    capability: text("capability").notNull().default("unknown"),
    confidence: doublePrecision("confidence").notNull().default(0.5),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.phoneHash, table.channel] })],
);

// R3.7/R3.8: precomputed by the score-recompute job (never at request time) — verification
// rate, not delivery rate, per (channel, country, carrier_class).
export const channelScores = pgTable(
  "channel_scores",
  {
    id: text("id").primaryKey(),
    channel: text("channel").notNull(),
    country: text("country").notNull(),
    // No carrier-detection signal exists yet (out of scope) — every row is "unknown"
    // until that lands, which keeps the column real without faking data it doesn't have.
    carrierClass: text("carrier_class").notNull().default("unknown"),
    verificationRate: doublePrecision("verification_rate").notNull(),
    p50Ms: integer("p50_ms").notNull(),
    p95Ms: integer("p95_ms").notNull(),
    costPerSuccessMicros: bigint("cost_per_success_micros", { mode: "number" }),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
  },
  (table) => [
    // rank-by-score.ts always wants the newest window for a (channel, country, carrier_class).
    index("channel_scores_lookup_idx").on(
      table.channel,
      table.country,
      table.carrierClass,
      table.windowEnd,
    ),
  ],
);

// R3.9: every routing decision persists whole — every channel considered, the one
// chosen, and the reason for every skip. This is what the dashboard's trace view (R10.6)
// renders.
export const routingDecisions = pgTable(
  "routing_decisions",
  {
    id: text("id").primaryKey(),
    verificationId: text("verification_id")
      .notNull()
      .references(() => verifications.id),
    consideredJson: jsonb("considered_json").$type<readonly string[]>().notNull(),
    chosenChannel: text("chosen_channel"),
    decisionLogJson: jsonb("decision_log_json").$type<unknown>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("routing_decisions_verification_id_idx").on(table.verificationId)],
);
