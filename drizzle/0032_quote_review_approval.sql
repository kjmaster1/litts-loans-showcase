-- Review notes and executive approval on mortgage quotes (owner, 2026-10-15; docs/research/18).
-- Notes are append-only: a note is marked done by a second row that resolves it.
CREATE TABLE "mortgage_quote_note" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quote_id" uuid NOT NULL,
	"resolves_id" uuid,
	"staff_id" uuid NOT NULL,
	"text" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mortgage_quote" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mortgage_quote" ADD COLUMN "approved_by_staff_id" uuid;--> statement-breakpoint
ALTER TABLE "mortgage_quote_note" ADD CONSTRAINT "mortgage_quote_note_quote_id_mortgage_quote_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."mortgage_quote"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mortgage_quote_note" ADD CONSTRAINT "mortgage_quote_note_resolves_id_mortgage_quote_note_id_fk" FOREIGN KEY ("resolves_id") REFERENCES "public"."mortgage_quote_note"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mortgage_quote_note" ADD CONSTRAINT "mortgage_quote_note_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mortgage_quote_note_quote_idx" ON "mortgage_quote_note" USING btree ("quote_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mortgage_quote_note_resolves_uq" ON "mortgage_quote_note" USING btree ("resolves_id");--> statement-breakpoint
ALTER TABLE "mortgage_quote" ADD CONSTRAINT "mortgage_quote_approved_by_staff_id_staff_id_fk" FOREIGN KEY ("approved_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE TRIGGER mortgage_quote_note_immutable BEFORE UPDATE OR DELETE ON mortgage_quote_note
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_mutation();
--> statement-breakpoint
REVOKE UPDATE, DELETE ON mortgage_quote_note FROM litts_app;
