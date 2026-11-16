ALTER TABLE "mortgage" ADD COLUMN "address_aliases" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "mortgage" ADD COLUMN "merged_into_id" uuid;--> statement-breakpoint
ALTER TABLE "mortgage" ADD CONSTRAINT "mortgage_merged_into_id_mortgage_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."mortgage"("id") ON DELETE no action ON UPDATE no action;