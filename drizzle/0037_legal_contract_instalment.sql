ALTER TABLE "legal_case" ADD COLUMN "contract_instalment_cents" bigint;--> statement-breakpoint
ALTER TABLE "legal_case" ADD COLUMN "contract_instalment_reason" text;--> statement-breakpoint
ALTER TABLE "legal_case" ADD COLUMN "contract_instalment_by_staff_id" uuid;--> statement-breakpoint
ALTER TABLE "legal_case" ADD COLUMN "contract_instalment_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "legal_case" ADD CONSTRAINT "legal_case_contract_instalment_by_staff_id_staff_id_fk" FOREIGN KEY ("contract_instalment_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_case" ADD CONSTRAINT "legal_case_contract_instalment_positive" CHECK ("legal_case"."contract_instalment_cents" is null or "legal_case"."contract_instalment_cents" > 0);