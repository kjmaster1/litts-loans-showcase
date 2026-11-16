CREATE TABLE "legal_case" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" serial NOT NULL,
	"loan_id" uuid NOT NULL,
	"default_at_override" timestamp with time zone,
	"details_requested_at" timestamp with time zone,
	"details_requested_by_staff_id" uuid,
	"contract_shared_at" timestamp with time zone,
	"contract_shared_by_staff_id" uuid,
	"closed_at" timestamp with time zone,
	"closed_by_staff_id" uuid,
	"close_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "legal_case_handover" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"handed_at" timestamp with time zone NOT NULL,
	"handed_by_staff_id" uuid NOT NULL,
	"payee_staff_id" uuid NOT NULL,
	"fee_cents" bigint NOT NULL,
	"sheet" jsonb NOT NULL,
	"text" text NOT NULL,
	"reason" text
);
--> statement-breakpoint
CREATE TABLE "legal_fee_link" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"bank_transaction_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"action" text NOT NULL,
	"method" text,
	"reason" text,
	"staff_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "loan" ADD COLUMN "default_fee_per_day_cents" bigint;--> statement-breakpoint
ALTER TABLE "loan" ADD COLUMN "unsecured" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "legal_case" ADD CONSTRAINT "legal_case_loan_id_loan_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_case" ADD CONSTRAINT "legal_case_details_requested_by_staff_id_staff_id_fk" FOREIGN KEY ("details_requested_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_case" ADD CONSTRAINT "legal_case_contract_shared_by_staff_id_staff_id_fk" FOREIGN KEY ("contract_shared_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_case" ADD CONSTRAINT "legal_case_closed_by_staff_id_staff_id_fk" FOREIGN KEY ("closed_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_case_handover" ADD CONSTRAINT "legal_case_handover_case_id_legal_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."legal_case"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_case_handover" ADD CONSTRAINT "legal_case_handover_handed_by_staff_id_staff_id_fk" FOREIGN KEY ("handed_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_case_handover" ADD CONSTRAINT "legal_case_handover_payee_staff_id_staff_id_fk" FOREIGN KEY ("payee_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_fee_link" ADD CONSTRAINT "legal_fee_link_bank_transaction_id_bank_transaction_id_fk" FOREIGN KEY ("bank_transaction_id") REFERENCES "public"."bank_transaction"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_fee_link" ADD CONSTRAINT "legal_fee_link_case_id_legal_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."legal_case"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_fee_link" ADD CONSTRAINT "legal_fee_link_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "legal_case_loan_uq" ON "legal_case" USING btree ("loan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "legal_case_number_uq" ON "legal_case" USING btree ("number");--> statement-breakpoint
CREATE INDEX "legal_case_handover_case_idx" ON "legal_case_handover" USING btree ("case_id","handed_at");--> statement-breakpoint
CREATE INDEX "legal_fee_link_tx_idx" ON "legal_fee_link" USING btree ("bank_transaction_id","id");--> statement-breakpoint
CREATE INDEX "legal_fee_link_case_idx" ON "legal_fee_link" USING btree ("case_id");--> statement-breakpoint
-- Append-only: what was handed to Legal, and the fee payments' link history, are never changed or removed.
CREATE TRIGGER legal_case_handover_immutable BEFORE UPDATE OR DELETE ON legal_case_handover
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER legal_fee_link_immutable BEFORE UPDATE OR DELETE ON legal_fee_link
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_mutation();
--> statement-breakpoint
REVOKE UPDATE, DELETE ON legal_case_handover, legal_fee_link FROM litts_app;
