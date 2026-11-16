ALTER TABLE "loan" ADD COLUMN "retired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "loan" ADD COLUMN "merged_into_id" uuid;--> statement-breakpoint
ALTER TABLE "loan" ADD CONSTRAINT "loan_merged_into_id_loan_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."loan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan" ADD CONSTRAINT "loan_retired_card_only" CHECK ("loan"."retired_at" is null or "loan"."disbursement_tx_id" is null);--> statement-breakpoint
ALTER TABLE "loan" ADD CONSTRAINT "loan_merged_retired" CHECK ("loan"."merged_into_id" is null or "loan"."retired_at" is not null);