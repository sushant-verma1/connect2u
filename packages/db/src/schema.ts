import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
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
    status: verificationStatus("status").notNull().default("pending"),
    attemptsUsed: integer("attempts_used").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifiedChannel: text("verified_channel"),
    timeToVerifyMs: integer("time_to_verify_ms"),
    metadataJson: jsonb("metadata_json").notNull().default({}),
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // R2.4 / ARCHITECTURE.md §7: partial index keeps lookups of in-flight verifications cheap.
    index("verifications_pending_idx")
      .on(table.status)
      .where(sql`${table.status} = 'pending'`),
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
    // I8 / G8: the rate applicable at send time, never looked up later.
    costMicrosAtSend: bigint("cost_micros_at_send", { mode: "number" }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    timeoutAt: timestamp("timeout_at", { withTimezone: true }),
  },
  (table) => [index("delivery_attempts_verification_id_idx").on(table.verificationId)],
);
