CREATE TABLE "webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"provider_message_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"signature_valid" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "verifications" ADD COLUMN "code_encrypted" text NOT NULL;--> statement-breakpoint
ALTER TABLE "verifications" ADD COLUMN "channel_chain" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_dedupe_idx" ON "webhook_events" USING btree ("provider","provider_message_id","event_type");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_attempts_provider_message_id_idx" ON "delivery_attempts" USING btree ("provider_message_id") WHERE "delivery_attempts"."provider_message_id" is not null;