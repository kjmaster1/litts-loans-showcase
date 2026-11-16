CREATE TYPE "public"."mortgage_funding" AS ENUM('state', 'company');--> statement-breakpoint
ALTER TABLE "mortgage" ADD COLUMN "funding" "mortgage_funding" DEFAULT 'state' NOT NULL;--> statement-breakpoint
ALTER TABLE "mortgage" ADD COLUMN "funding_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "mortgage_payment" ADD COLUMN "entry_id" uuid;--> statement-breakpoint
ALTER TABLE "mortgage" ADD CONSTRAINT "mortgage_funding_entry_id_journal_entry_id_fk" FOREIGN KEY ("funding_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mortgage_payment" ADD CONSTRAINT "mortgage_payment_entry_id_journal_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Mortgages lent from Litt's own money (docs/design/MORTGAGES.md §Company-funded).
INSERT INTO ledger_account (code, name, type, description) VALUES
  ('1120', 'Mortgages receivable — company-funded', 'asset', 'Principal Litt''s lent on mortgages funded from company money, still to be repaid');
--> statement-breakpoint
-- Agreements pasted before funding was recorded: no fed rate and no federal interest
-- on the tablet means Litt's lent its own money (the sync then books them).
UPDATE mortgage SET funding = 'company'
  WHERE last_tablet_at IS NOT NULL AND fed_rate_bp IS NULL AND federal_interest_cents IS NULL AND loan_cents IS NOT NULL;
