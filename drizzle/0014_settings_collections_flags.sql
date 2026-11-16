CREATE TYPE "public"."collection_kind" AS ENUM('contacted', 'no_answer', 'promise', 'handed_to_legal', 'seizure', 'note');--> statement-breakpoint
CREATE TABLE "borrower_flag" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"borrower_state_id" integer NOT NULL,
	"reason" text NOT NULL,
	"set_by_staff_id" uuid NOT NULL,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cleared_at" timestamp with time zone,
	"cleared_by_staff_id" uuid,
	"clear_reason" text
);
--> statement-breakpoint
CREATE TABLE "loan_collection_action" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"loan_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"staff_id" uuid NOT NULL,
	"kind" "collection_kind" NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"promise_cents" bigint,
	"promise_by" timestamp with time zone,
	"next_action_at" timestamp with time zone,
	CONSTRAINT "loan_collection_promise_whole_dollars" CHECK ("loan_collection_action"."promise_cents" is null or "loan_collection_action"."promise_cents" % 100 = 0)
);
--> statement-breakpoint
CREATE TABLE "company_setting" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"values" jsonb NOT NULL,
	"reason" text NOT NULL,
	"created_by_staff_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "borrower_flag" ADD CONSTRAINT "borrower_flag_set_by_staff_id_staff_id_fk" FOREIGN KEY ("set_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "borrower_flag" ADD CONSTRAINT "borrower_flag_cleared_by_staff_id_staff_id_fk" FOREIGN KEY ("cleared_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_collection_action" ADD CONSTRAINT "loan_collection_action_loan_id_loan_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_collection_action" ADD CONSTRAINT "loan_collection_action_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_setting" ADD CONSTRAINT "company_setting_created_by_staff_id_staff_id_fk" FOREIGN KEY ("created_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "borrower_flag_open_uq" ON "borrower_flag" USING btree ("borrower_state_id") WHERE "borrower_flag"."cleared_at" is null;--> statement-breakpoint
CREATE INDEX "loan_collection_action_loan_idx" ON "loan_collection_action" USING btree ("loan_id","at");--> statement-breakpoint
-- Append-only: corrections are new entries / new versions.
CREATE TRIGGER loan_collection_action_immutable BEFORE UPDATE OR DELETE ON loan_collection_action
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER company_setting_immutable BEFORE UPDATE OR DELETE ON company_setting
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_mutation();
--> statement-breakpoint
INSERT INTO ledger_account (code, name, type, description) VALUES
  ('5150', 'Interest paid on staff loans', 'expense', 'What staff were repaid beyond what they lent the company (research/11)');
