CREATE TABLE "notification_read" (
	"staff_id" uuid NOT NULL,
	"key" text NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_read_staff_id_key_pk" PRIMARY KEY("staff_id","key")
);
--> statement-breakpoint
ALTER TABLE "loan_collection_action" ALTER COLUMN "loan_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "loan_collection_action" ADD COLUMN "mortgage_id" uuid;--> statement-breakpoint
ALTER TABLE "notification_read" ADD CONSTRAINT "notification_read_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_collection_action" ADD CONSTRAINT "loan_collection_action_mortgage_id_mortgage_id_fk" FOREIGN KEY ("mortgage_id") REFERENCES "public"."mortgage"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "loan_collection_action_mortgage_idx" ON "loan_collection_action" USING btree ("mortgage_id","at");--> statement-breakpoint
ALTER TABLE "loan_collection_action" ADD CONSTRAINT "loan_collection_one_target" CHECK (("loan_collection_action"."loan_id" is null) <> ("loan_collection_action"."mortgage_id" is null));