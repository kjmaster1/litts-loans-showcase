CREATE TYPE "public"."collateral_status" AS ENUM('held', 'repossessed', 'sold', 'released');--> statement-breakpoint
CREATE TYPE "public"."loan_status" AS ENUM('active', 'overdue', 'defaulted', 'written_off', 'completed');--> statement-breakpoint
CREATE TYPE "public"."loan_tab" AS ENUM('active', 'overdue', 'default', 'complete');--> statement-breakpoint
CREATE TABLE "loan" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"borrower_state_id" integer NOT NULL,
	"borrower_name" text,
	"principal_cents" bigint NOT NULL,
	"instalments" integer,
	"period_days" integer,
	"broker_rate_bp" integer,
	"state_rate_bp" integer,
	"opened_at" timestamp with time zone,
	"disbursement_tx_id" uuid,
	"agreement_ref" text,
	"status" "loan_status" DEFAULT 'active' NOT NULL,
	"officer_staff_id" uuid,
	"first_default_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"written_off_at" timestamp with time zone,
	"write_off_entry_id" uuid,
	"last_card_at" timestamp with time zone,
	"last_card_tab" "loan_tab",
	"last_completed" integer,
	"last_missed" integer,
	"last_remaining_cents" bigint,
	"next_payment_due_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loan_principal_positive" CHECK ("loan"."principal_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "loan_card" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"paste_id" uuid NOT NULL,
	"loan_id" uuid,
	"position" integer NOT NULL,
	"raw" text NOT NULL,
	"parsed" jsonb NOT NULL,
	"match_how" text
);
--> statement-breakpoint
CREATE TABLE "loan_collateral" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"loan_id" uuid NOT NULL,
	"description" text NOT NULL,
	"estimated_value_cents" bigint,
	"status" "collateral_status" DEFAULT 'held' NOT NULL,
	"created_by_staff_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loan_event" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"loan_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"staff_id" uuid
);
--> statement-breakpoint
CREATE TABLE "loan_paste" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tab" "loan_tab" NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_staff_id" uuid,
	"card_count" integer NOT NULL,
	"matched_count" integer NOT NULL,
	"created_count" integer NOT NULL,
	"ignored_count" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loan_payment_link" (
	"bank_transaction_id" uuid PRIMARY KEY NOT NULL,
	"loan_id" uuid NOT NULL,
	"role" text NOT NULL,
	"method" text NOT NULL,
	"levy_cents" bigint DEFAULT 0 NOT NULL,
	"levy_entry_id" uuid,
	"recovery_entry_id" uuid
);
--> statement-breakpoint
ALTER TABLE "loan" ADD CONSTRAINT "loan_disbursement_tx_id_bank_transaction_id_fk" FOREIGN KEY ("disbursement_tx_id") REFERENCES "public"."bank_transaction"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan" ADD CONSTRAINT "loan_officer_staff_id_staff_id_fk" FOREIGN KEY ("officer_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan" ADD CONSTRAINT "loan_write_off_entry_id_journal_entry_id_fk" FOREIGN KEY ("write_off_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_card" ADD CONSTRAINT "loan_card_paste_id_loan_paste_id_fk" FOREIGN KEY ("paste_id") REFERENCES "public"."loan_paste"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_card" ADD CONSTRAINT "loan_card_loan_id_loan_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_collateral" ADD CONSTRAINT "loan_collateral_loan_id_loan_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_collateral" ADD CONSTRAINT "loan_collateral_created_by_staff_id_staff_id_fk" FOREIGN KEY ("created_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_event" ADD CONSTRAINT "loan_event_loan_id_loan_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_event" ADD CONSTRAINT "loan_event_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_paste" ADD CONSTRAINT "loan_paste_created_by_staff_id_staff_id_fk" FOREIGN KEY ("created_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_payment_link" ADD CONSTRAINT "loan_payment_link_bank_transaction_id_bank_transaction_id_fk" FOREIGN KEY ("bank_transaction_id") REFERENCES "public"."bank_transaction"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_payment_link" ADD CONSTRAINT "loan_payment_link_loan_id_loan_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_payment_link" ADD CONSTRAINT "loan_payment_link_levy_entry_id_journal_entry_id_fk" FOREIGN KEY ("levy_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_payment_link" ADD CONSTRAINT "loan_payment_link_recovery_entry_id_journal_entry_id_fk" FOREIGN KEY ("recovery_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "loan_disbursement_uq" ON "loan" USING btree ("disbursement_tx_id");--> statement-breakpoint
CREATE INDEX "loan_borrower_idx" ON "loan" USING btree ("borrower_state_id");--> statement-breakpoint
CREATE INDEX "loan_status_idx" ON "loan" USING btree ("status");--> statement-breakpoint
CREATE INDEX "loan_officer_idx" ON "loan" USING btree ("officer_staff_id");--> statement-breakpoint
CREATE INDEX "loan_card_loan_idx" ON "loan_card" USING btree ("loan_id");--> statement-breakpoint
CREATE INDEX "loan_card_paste_idx" ON "loan_card" USING btree ("paste_id");--> statement-breakpoint
CREATE INDEX "loan_collateral_loan_idx" ON "loan_collateral" USING btree ("loan_id");--> statement-breakpoint
CREATE INDEX "loan_event_loan_idx" ON "loan_event" USING btree ("loan_id","at");--> statement-breakpoint
CREATE INDEX "loan_payment_link_loan_idx" ON "loan_payment_link" USING btree ("loan_id");