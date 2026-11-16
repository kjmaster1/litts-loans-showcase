CREATE TYPE "public"."mortgage_status" AS ENUM('active', 'completed', 'defaulted');--> statement-breakpoint
CREATE TABLE "allowance_reading" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"balance_cents" bigint NOT NULL,
	"note" text,
	"created_by_staff_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by_staff_id" uuid,
	"void_reason" text,
	CONSTRAINT "allowance_reading_whole_dollars" CHECK ("allowance_reading"."balance_cents" % 100 = 0)
);
--> statement-breakpoint
CREATE TABLE "app_setting" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by_staff_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mortgage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"address" text NOT NULL,
	"origination_tx_id" uuid,
	"originated_at" timestamp with time zone,
	"buyer_state_id" integer,
	"buyer_name" text,
	"status" "mortgage_status" DEFAULT 'active' NOT NULL,
	"property_type" text,
	"land_count" integer,
	"price_cents" bigint,
	"down_payment_cents" bigint,
	"loan_cents" bigint,
	"broker_interest_cents" bigint,
	"federal_interest_cents" bigint,
	"instalments" integer,
	"term_months" integer,
	"fed_rate_bp" integer,
	"broker_rate_bp" integer,
	"late_fee_cents" bigint,
	"grace_period_days" integer,
	"broker_fee_cents" bigint,
	"agency_commission_cents" bigint,
	"owner_name" text,
	"agency_name" text,
	"agent_state_id" integer,
	"agent_name" text,
	"officer_state_id" integer,
	"officer_name" text,
	"officer_staff_id" uuid,
	"last_tablet_at" timestamp with time zone,
	"last_paid_count" integer,
	"last_remaining_cents" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mortgage_event" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"mortgage_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"staff_id" uuid
);
--> statement-breakpoint
CREATE TABLE "mortgage_paste" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_staff_id" uuid,
	"count" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mortgage_payment" (
	"bank_transaction_id" uuid PRIMARY KEY NOT NULL,
	"mortgage_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mortgage_snapshot" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"paste_id" uuid NOT NULL,
	"mortgage_id" uuid,
	"raw" text NOT NULL,
	"parsed" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "allowance_reading" ADD CONSTRAINT "allowance_reading_created_by_staff_id_staff_id_fk" FOREIGN KEY ("created_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allowance_reading" ADD CONSTRAINT "allowance_reading_voided_by_staff_id_staff_id_fk" FOREIGN KEY ("voided_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_setting" ADD CONSTRAINT "app_setting_updated_by_staff_id_staff_id_fk" FOREIGN KEY ("updated_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mortgage" ADD CONSTRAINT "mortgage_origination_tx_id_bank_transaction_id_fk" FOREIGN KEY ("origination_tx_id") REFERENCES "public"."bank_transaction"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mortgage" ADD CONSTRAINT "mortgage_officer_staff_id_staff_id_fk" FOREIGN KEY ("officer_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mortgage_event" ADD CONSTRAINT "mortgage_event_mortgage_id_mortgage_id_fk" FOREIGN KEY ("mortgage_id") REFERENCES "public"."mortgage"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mortgage_event" ADD CONSTRAINT "mortgage_event_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mortgage_paste" ADD CONSTRAINT "mortgage_paste_created_by_staff_id_staff_id_fk" FOREIGN KEY ("created_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mortgage_payment" ADD CONSTRAINT "mortgage_payment_bank_transaction_id_bank_transaction_id_fk" FOREIGN KEY ("bank_transaction_id") REFERENCES "public"."bank_transaction"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mortgage_payment" ADD CONSTRAINT "mortgage_payment_mortgage_id_mortgage_id_fk" FOREIGN KEY ("mortgage_id") REFERENCES "public"."mortgage"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mortgage_snapshot" ADD CONSTRAINT "mortgage_snapshot_paste_id_mortgage_paste_id_fk" FOREIGN KEY ("paste_id") REFERENCES "public"."mortgage_paste"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mortgage_snapshot" ADD CONSTRAINT "mortgage_snapshot_mortgage_id_mortgage_id_fk" FOREIGN KEY ("mortgage_id") REFERENCES "public"."mortgage"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "allowance_reading_observed_idx" ON "allowance_reading" USING btree ("observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mortgage_origination_uq" ON "mortgage" USING btree ("origination_tx_id");--> statement-breakpoint
CREATE INDEX "mortgage_address_idx" ON "mortgage" USING btree ("address");--> statement-breakpoint
CREATE INDEX "mortgage_buyer_idx" ON "mortgage" USING btree ("buyer_state_id");--> statement-breakpoint
CREATE INDEX "mortgage_officer_idx" ON "mortgage" USING btree ("officer_staff_id");--> statement-breakpoint
CREATE INDEX "mortgage_event_mortgage_idx" ON "mortgage_event" USING btree ("mortgage_id","at");--> statement-breakpoint
CREATE INDEX "mortgage_payment_mortgage_idx" ON "mortgage_payment" USING btree ("mortgage_id");--> statement-breakpoint
CREATE INDEX "mortgage_snapshot_mortgage_idx" ON "mortgage_snapshot" USING btree ("mortgage_id");--> statement-breakpoint
-- Mortgage events are a history: append-only like loan events.
CREATE TRIGGER mortgage_event_immutable BEFORE UPDATE OR DELETE ON mortgage_event
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_mutation();
--> statement-breakpoint
-- Allowance readings can only be voided (void columns, once), never edited or deleted.
CREATE FUNCTION allowance_reading_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'allowance_reading is append-only';
  END IF;
  IF OLD.voided_at IS NOT NULL
     OR NEW.observed_at IS DISTINCT FROM OLD.observed_at
     OR NEW.balance_cents IS DISTINCT FROM OLD.balance_cents
     OR NEW.note IS DISTINCT FROM OLD.note
     OR NEW.created_by_staff_id IS DISTINCT FROM OLD.created_by_staff_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'allowance_reading is immutable except for voiding once';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER allowance_reading_guard BEFORE UPDATE OR DELETE ON allowance_reading
  FOR EACH ROW EXECUTE FUNCTION allowance_reading_guard();
