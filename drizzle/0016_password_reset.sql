CREATE TABLE "staff_password_reset" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_staff_id" uuid NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "staff_password_reset" ADD CONSTRAINT "staff_password_reset_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "staff_password_reset_token_hash_uq" ON "staff_password_reset" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "staff_password_reset_staff_idx" ON "staff_password_reset" USING btree ("staff_id");