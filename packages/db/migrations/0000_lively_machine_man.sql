CREATE TYPE "public"."account_status" AS ENUM('active', 'manual_review', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."delivery_status" AS ENUM('queued', 'sent', 'delivered', 'failed', 'timed_out');--> statement-breakpoint
CREATE TYPE "public"."verification_status" AS ENUM('pending', 'verified', 'expired', 'burned', 'failed');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"api_key_hash" text NOT NULL,
	"api_key_prefix" text NOT NULL,
	"status" "account_status" DEFAULT 'active' NOT NULL,
	"daily_cost_cap_micros" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_api_key_prefix_unique" UNIQUE("api_key_prefix")
);
--> statement-breakpoint
CREATE TABLE "delivery_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"verification_id" text NOT NULL,
	"account_id" text NOT NULL,
	"channel" text NOT NULL,
	"provider" text NOT NULL,
	"provider_message_id" text,
	"status" "delivery_status" DEFAULT 'queued' NOT NULL,
	"error_code" text,
	"cost_micros_at_send" bigint,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"timeout_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"phone_hash" text NOT NULL,
	"phone_encrypted" text NOT NULL,
	"code_hmac" text NOT NULL,
	"status" "verification_status" DEFAULT 'pending' NOT NULL,
	"attempts_used" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone,
	"verified_channel" text,
	"time_to_verify_ms" integer,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_verification_id_verifications_id_fk" FOREIGN KEY ("verification_id") REFERENCES "public"."verifications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "delivery_attempts_verification_id_idx" ON "delivery_attempts" USING btree ("verification_id");--> statement-breakpoint
CREATE INDEX "verifications_pending_idx" ON "verifications" USING btree ("status") WHERE "verifications"."status" = 'pending';