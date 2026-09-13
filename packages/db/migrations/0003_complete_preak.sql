CREATE TABLE "channel_capability" (
	"phone_hash" text NOT NULL,
	"channel" text NOT NULL,
	"capability" text DEFAULT 'unknown' NOT NULL,
	"confidence" double precision DEFAULT 0.5 NOT NULL,
	"last_success_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_capability_phone_hash_channel_pk" PRIMARY KEY("phone_hash","channel")
);
--> statement-breakpoint
CREATE TABLE "channel_scores" (
	"id" text PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"country" text NOT NULL,
	"carrier_class" text DEFAULT 'unknown' NOT NULL,
	"verification_rate" double precision NOT NULL,
	"p50_ms" integer NOT NULL,
	"p95_ms" integer NOT NULL,
	"cost_per_success_micros" bigint,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routing_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"verification_id" text NOT NULL,
	"considered_json" jsonb NOT NULL,
	"chosen_channel" text,
	"decision_log_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routing_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"version" integer NOT NULL,
	"policy_json" jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "routing_decisions" ADD CONSTRAINT "routing_decisions_verification_id_verifications_id_fk" FOREIGN KEY ("verification_id") REFERENCES "public"."verifications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_policies" ADD CONSTRAINT "routing_policies_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_scores_lookup_idx" ON "channel_scores" USING btree ("channel","country","carrier_class","window_end");--> statement-breakpoint
CREATE INDEX "routing_decisions_verification_id_idx" ON "routing_decisions" USING btree ("verification_id");--> statement-breakpoint
CREATE INDEX "routing_policies_account_id_idx" ON "routing_policies" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "routing_policies_account_active_idx" ON "routing_policies" USING btree ("account_id") WHERE "routing_policies"."active" = true;