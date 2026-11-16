CREATE TYPE "public"."ledger_account_type" AS ENUM('asset', 'liability', 'equity', 'income', 'expense', 'memo');--> statement-breakpoint
CREATE TYPE "public"."classification_confidence" AS ENUM('certain', 'tag', 'heuristic', 'unclassified', 'manual');--> statement-breakpoint
CREATE TYPE "public"."journal_entry_kind" AS ENUM('bank_posting', 'reversal', 'mortgage_settlement', 'adjustment');--> statement-breakpoint
CREATE TYPE "public"."bank_tx_direction" AS ENUM('in', 'out');--> statement-breakpoint
CREATE TABLE "bank_transaction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"wallet_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"direction" "bank_tx_direction" NOT NULL,
	"tx_type" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"tax_cents" bigint DEFAULT 0 NOT NULL,
	"tax_percent" text,
	"source_wallet" text,
	"target_wallet" text,
	"initiator_name" text,
	"initiator_state_id" integer,
	"comment" text NOT NULL,
	"fingerprint" text NOT NULL,
	"occurrence" integer NOT NULL,
	"category" text NOT NULL,
	"confidence" "classification_confidence" NOT NULL,
	"ruleset_version" integer NOT NULL,
	"classified_by_staff_id" uuid,
	"posting_entry_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_tx_amount_positive" CHECK ("bank_transaction"."amount_cents" > 0),
	CONSTRAINT "bank_tx_tax_nonnegative" CHECK ("bank_transaction"."tax_cents" >= 0 and "bank_transaction"."tax_cents" <= "bank_transaction"."amount_cents")
);
--> statement-breakpoint
CREATE TABLE "import_batch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"file_name" text NOT NULL,
	"file_sha256" text NOT NULL,
	"wallet_id" text NOT NULL,
	"export_timezone" text NOT NULL,
	"reported_balance_cents" bigint NOT NULL,
	"first_tx_at" timestamp with time zone,
	"last_tx_at" timestamp with time zone,
	"row_count" integer NOT NULL,
	"new_count" integer NOT NULL,
	"duplicate_count" integer NOT NULL,
	"ruleset_version" integer NOT NULL,
	"created_by_staff_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_staging" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_by_staff_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"file_sha256" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" "journal_entry_kind" NOT NULL,
	"description" text NOT NULL,
	"bank_transaction_id" uuid,
	"reverses_entry_id" uuid,
	"batch_id" uuid,
	"created_by_staff_id" uuid,
	"reason" text
);
--> statement-breakpoint
CREATE TABLE "journal_line" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"entry_id" uuid NOT NULL,
	"account_code" text NOT NULL,
	"debit_cents" bigint DEFAULT 0 NOT NULL,
	"credit_cents" bigint DEFAULT 0 NOT NULL,
	"memo" text,
	CONSTRAINT "journal_line_one_sided" CHECK ("journal_line"."debit_cents" >= 0 and "journal_line"."credit_cents" >= 0 and (("journal_line"."debit_cents" = 0) <> ("journal_line"."credit_cents" = 0)))
);
--> statement-breakpoint
CREATE TABLE "ledger_account" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" "ledger_account_type" NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mortgage_settlement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"address" text NOT NULL,
	"in_tx_id" uuid NOT NULL,
	"out_tx_id" uuid NOT NULL,
	"journal_entry_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unwound_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "bank_transaction" ADD CONSTRAINT "bank_transaction_batch_id_import_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entry" ADD CONSTRAINT "journal_entry_bank_transaction_id_bank_transaction_id_fk" FOREIGN KEY ("bank_transaction_id") REFERENCES "public"."bank_transaction"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entry" ADD CONSTRAINT "journal_entry_batch_id_import_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_line" ADD CONSTRAINT "journal_line_entry_id_journal_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_line" ADD CONSTRAINT "journal_line_account_code_ledger_account_code_fk" FOREIGN KEY ("account_code") REFERENCES "public"."ledger_account"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mortgage_settlement" ADD CONSTRAINT "mortgage_settlement_in_tx_id_bank_transaction_id_fk" FOREIGN KEY ("in_tx_id") REFERENCES "public"."bank_transaction"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mortgage_settlement" ADD CONSTRAINT "mortgage_settlement_out_tx_id_bank_transaction_id_fk" FOREIGN KEY ("out_tx_id") REFERENCES "public"."bank_transaction"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mortgage_settlement" ADD CONSTRAINT "mortgage_settlement_journal_entry_id_journal_entry_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_tx_fingerprint_occurrence_uq" ON "bank_transaction" USING btree ("fingerprint","occurrence");--> statement-breakpoint
CREATE INDEX "bank_tx_occurred_at_idx" ON "bank_transaction" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "bank_tx_category_idx" ON "bank_transaction" USING btree ("category");--> statement-breakpoint
CREATE INDEX "bank_tx_initiator_state_id_idx" ON "bank_transaction" USING btree ("initiator_state_id");--> statement-breakpoint
CREATE INDEX "import_batch_created_at_idx" ON "import_batch" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "journal_entry_effective_at_idx" ON "journal_entry" USING btree ("effective_at");--> statement-breakpoint
CREATE INDEX "journal_entry_bank_tx_idx" ON "journal_entry" USING btree ("bank_transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entry_reverses_uq" ON "journal_entry" USING btree ("reverses_entry_id");--> statement-breakpoint
CREATE INDEX "journal_line_entry_idx" ON "journal_line" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "journal_line_account_idx" ON "journal_line" USING btree ("account_code");--> statement-breakpoint
CREATE INDEX "mortgage_settlement_in_idx" ON "mortgage_settlement" USING btree ("in_tx_id");--> statement-breakpoint
CREATE INDEX "mortgage_settlement_out_idx" ON "mortgage_settlement" USING btree ("out_tx_id");