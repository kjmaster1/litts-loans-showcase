CREATE TYPE "public"."loan_offer_kind" AS ENUM('vehicle', 'property', 'general');--> statement-breakpoint
CREATE TYPE "public"."loan_offer_status" AS ENUM('draft', 'issued', 'funded', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."mortgage_quote_status" AS ENUM('open', 'matched', 'cancelled');--> statement-breakpoint
CREATE TABLE "loan_offer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" serial NOT NULL,
	"kind" "loan_offer_kind" NOT NULL,
	"status" "loan_offer_status" DEFAULT 'draft' NOT NULL,
	"borrower_state_id" integer NOT NULL,
	"borrower_name" text NOT NULL,
	"officer_staff_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"rate_bp" integer NOT NULL,
	"state_rate_bp" integer NOT NULL,
	"weeks" integer NOT NULL,
	"starts_on" timestamp with time zone NOT NULL,
	"collateral" text,
	"collateral_value_cents" bigint,
	"purpose" text,
	"weekly_income_cents" bigint,
	"default_fee_per_day_cents" bigint NOT NULL,
	"purchase_days" integer NOT NULL,
	"details_hours" integer NOT NULL,
	"extra_hours" integer NOT NULL,
	"default_after_days" integer NOT NULL,
	"suggested_rate_bp" integer,
	"notes" text DEFAULT '' NOT NULL,
	"contract_text" text,
	"issued_at" timestamp with time zone,
	"issued_by_staff_id" uuid,
	"loan_id" uuid,
	"funded_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_by_staff_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mortgage_quote" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" serial NOT NULL,
	"status" "mortgage_quote_status" DEFAULT 'open' NOT NULL,
	"buyer_state_id" integer NOT NULL,
	"buyer_name" text NOT NULL,
	"officer_staff_id" uuid NOT NULL,
	"address" text NOT NULL,
	"price_cents" bigint NOT NULL,
	"agency_commission_cents" bigint NOT NULL,
	"down_payment_bp" integer NOT NULL,
	"term_months" integer NOT NULL,
	"fed_rate_bp" integer NOT NULL,
	"broker_rate_bp" integer NOT NULL,
	"banker_fee_bp" integer NOT NULL,
	"primary_residence" boolean NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"mortgage_id" uuid,
	"matched_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_by_staff_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "loan_offer" ADD CONSTRAINT "loan_offer_officer_staff_id_staff_id_fk" FOREIGN KEY ("officer_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_offer" ADD CONSTRAINT "loan_offer_issued_by_staff_id_staff_id_fk" FOREIGN KEY ("issued_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_offer" ADD CONSTRAINT "loan_offer_loan_id_loan_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_offer" ADD CONSTRAINT "loan_offer_created_by_staff_id_staff_id_fk" FOREIGN KEY ("created_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mortgage_quote" ADD CONSTRAINT "mortgage_quote_officer_staff_id_staff_id_fk" FOREIGN KEY ("officer_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mortgage_quote" ADD CONSTRAINT "mortgage_quote_mortgage_id_mortgage_id_fk" FOREIGN KEY ("mortgage_id") REFERENCES "public"."mortgage"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mortgage_quote" ADD CONSTRAINT "mortgage_quote_created_by_staff_id_staff_id_fk" FOREIGN KEY ("created_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "loan_offer_borrower_idx" ON "loan_offer" USING btree ("borrower_state_id");--> statement-breakpoint
CREATE INDEX "loan_offer_officer_idx" ON "loan_offer" USING btree ("officer_staff_id");--> statement-breakpoint
CREATE INDEX "loan_offer_status_idx" ON "loan_offer" USING btree ("status");--> statement-breakpoint
CREATE INDEX "mortgage_quote_buyer_idx" ON "mortgage_quote" USING btree ("buyer_state_id");--> statement-breakpoint
CREATE INDEX "mortgage_quote_officer_idx" ON "mortgage_quote" USING btree ("officer_staff_id");