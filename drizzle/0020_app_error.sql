CREATE TABLE "app_error" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"route" text,
	"method" text,
	"message" text NOT NULL,
	"digest" text
);
--> statement-breakpoint
CREATE INDEX "app_error_occurred_idx" ON "app_error" USING btree ("occurred_at");