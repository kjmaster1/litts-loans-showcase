ALTER TYPE "public"."mortgage_quote_status" RENAME VALUE 'open' TO 'draft';--> statement-breakpoint
ALTER TYPE "public"."mortgage_quote_status" ADD VALUE 'confirmed' BEFORE 'matched';--> statement-breakpoint
ALTER TABLE "mortgage_quote" ALTER COLUMN "status" SET DEFAULT 'draft';--> statement-breakpoint
ALTER TABLE "mortgage_quote" ADD COLUMN "expected_signing_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mortgage_quote" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mortgage_quote" ADD COLUMN "confirmed_by_staff_id" uuid;--> statement-breakpoint
ALTER TABLE "mortgage_quote" ADD COLUMN "signed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mortgage_quote" ADD COLUMN "signed_by_staff_id" uuid;--> statement-breakpoint
ALTER TABLE "mortgage_quote" ADD CONSTRAINT "mortgage_quote_confirmed_by_staff_id_staff_id_fk" FOREIGN KEY ("confirmed_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mortgage_quote" ADD CONSTRAINT "mortgage_quote_signed_by_staff_id_staff_id_fk" FOREIGN KEY ("signed_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;
