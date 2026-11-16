ALTER TABLE "loan" ADD COLUMN "status_locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "loan" ADD COLUMN "status_lock_reason" text;