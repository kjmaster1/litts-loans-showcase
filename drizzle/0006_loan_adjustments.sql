CREATE TABLE "loan_adjustment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"loan_id" uuid NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "loan_adjustment" ADD CONSTRAINT "loan_adjustment_loan_id_loan_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_adjustment" ADD CONSTRAINT "loan_adjustment_journal_entry_id_journal_entry_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "loan_adjustment_loan_idx" ON "loan_adjustment" USING btree ("loan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "loan_adjustment_entry_uq" ON "loan_adjustment" USING btree ("journal_entry_id");--> statement-breakpoint
-- Closing adjustments (docs/design/LOANS.md §Accounting).
INSERT INTO ledger_account (code, name, type, description) VALUES
  ('4310', 'Loan closing surplus', 'income', 'Principal received above the books when the game marks a loan complete'),
  ('5110', 'Loan closing shortfall', 'expense', 'Principal left on the books when the game marks a loan complete');
--> statement-breakpoint
CREATE TRIGGER loan_adjustment_immutable BEFORE UPDATE OR DELETE ON loan_adjustment
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_mutation();
