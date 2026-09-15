ALTER TABLE "accounts" DROP COLUMN "api_key_hash";--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN "api_key_prefix";--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "email" text;--> statement-breakpoint
UPDATE "accounts" SET "email" = "id" || '@placeholder.invalid' WHERE "email" IS NULL;--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "email" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_email_unique" UNIQUE("email");--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "google_sub" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_google_sub_unique" UNIQUE("google_sub");--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_key_prefix_unique" UNIQUE("key_prefix")
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_account_id_idx" ON "api_keys" USING btree ("account_id");
