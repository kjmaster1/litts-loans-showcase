CREATE TYPE "public"."commission_week_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TYPE "public"."commission_payout_status" AS ENUM('unmatched', 'matched', 'old_scheme');--> statement-breakpoint
CREATE TABLE "commission_award" (
	"week_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	CONSTRAINT "commission_award_week_id_staff_id_pk" PRIMARY KEY("week_id","staff_id")
);
--> statement-breakpoint
CREATE TABLE "commission_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"week_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"base_cents" bigint NOT NULL,
	"amount_cents" bigint NOT NULL,
	"source_tx_id" uuid,
	"loan_id" uuid,
	"mortgage_id" uuid
);
--> statement-breakpoint
CREATE TABLE "commission_payout" (
	"bank_transaction_id" uuid PRIMARY KEY NOT NULL,
	"status" "commission_payout_status" DEFAULT 'unmatched' NOT NULL,
	"staff_id" uuid,
	"entry_id" uuid,
	"matched_by" text,
	"decided_by_staff_id" uuid,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "commission_roster" (
	"week_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"included" boolean NOT NULL,
	"suggested" boolean NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"decided_by_staff_id" uuid,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commission_roster_week_id_staff_id_pk" PRIMARY KEY("week_id","staff_id")
);
--> statement-breakpoint
CREATE TABLE "commission_week" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"week_key" text NOT NULL,
	"status" "commission_week_status" DEFAULT 'open' NOT NULL,
	"roster_locked_at" timestamp with time zone,
	"roster_locked_by_staff_id" uuid,
	"closed_at" timestamp with time zone,
	"closed_by_staff_id" uuid,
	"entry_id" uuid,
	"summary" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN "wallet_id" text;--> statement-breakpoint
ALTER TABLE "commission_award" ADD CONSTRAINT "commission_award_week_id_commission_week_id_fk" FOREIGN KEY ("week_id") REFERENCES "public"."commission_week"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_award" ADD CONSTRAINT "commission_award_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_line" ADD CONSTRAINT "commission_line_week_id_commission_week_id_fk" FOREIGN KEY ("week_id") REFERENCES "public"."commission_week"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_line" ADD CONSTRAINT "commission_line_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_line" ADD CONSTRAINT "commission_line_source_tx_id_bank_transaction_id_fk" FOREIGN KEY ("source_tx_id") REFERENCES "public"."bank_transaction"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_payout" ADD CONSTRAINT "commission_payout_bank_transaction_id_bank_transaction_id_fk" FOREIGN KEY ("bank_transaction_id") REFERENCES "public"."bank_transaction"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_payout" ADD CONSTRAINT "commission_payout_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_payout" ADD CONSTRAINT "commission_payout_entry_id_journal_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_payout" ADD CONSTRAINT "commission_payout_decided_by_staff_id_staff_id_fk" FOREIGN KEY ("decided_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_roster" ADD CONSTRAINT "commission_roster_week_id_commission_week_id_fk" FOREIGN KEY ("week_id") REFERENCES "public"."commission_week"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_roster" ADD CONSTRAINT "commission_roster_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_roster" ADD CONSTRAINT "commission_roster_decided_by_staff_id_staff_id_fk" FOREIGN KEY ("decided_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_week" ADD CONSTRAINT "commission_week_roster_locked_by_staff_id_staff_id_fk" FOREIGN KEY ("roster_locked_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_week" ADD CONSTRAINT "commission_week_closed_by_staff_id_staff_id_fk" FOREIGN KEY ("closed_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_week" ADD CONSTRAINT "commission_week_entry_id_journal_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commission_line_week_idx" ON "commission_line" USING btree ("week_id");--> statement-breakpoint
CREATE INDEX "commission_line_staff_idx" ON "commission_line" USING btree ("staff_id");--> statement-breakpoint
CREATE INDEX "commission_payout_staff_idx" ON "commission_payout" USING btree ("staff_id");--> statement-breakpoint
CREATE UNIQUE INDEX "commission_week_key_uq" ON "commission_week" USING btree ("week_key");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_wallet_uq" ON "staff" USING btree ("wallet_id");--> statement-breakpoint
-- Commission accruals (docs/design/COMMISSIONS.md).
INSERT INTO ledger_account (code, name, type, description) VALUES
  ('2000', 'Commissions payable', 'liability', 'Commission earned by staff (weeks closed) and not yet paid')
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint
-- Closed weeks are final: their lines and awards never change.
CREATE TRIGGER commission_line_immutable BEFORE UPDATE OR DELETE ON commission_line
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER commission_award_immutable BEFORE UPDATE OR DELETE ON commission_award
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_mutation();
