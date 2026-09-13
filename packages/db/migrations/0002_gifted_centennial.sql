CREATE TABLE "provider_rates" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"channel" text NOT NULL,
	"country" text NOT NULL,
	"message_type" text DEFAULT 'authentication' NOT NULL,
	"rate_micros" bigint NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "webhook_events_dedupe_idx";--> statement-breakpoint
CREATE INDEX "provider_rates_lookup_idx" ON "provider_rates" USING btree ("provider","channel","country","message_type","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_dedupe_idx" ON "webhook_events" USING btree ("provider","provider_message_id");