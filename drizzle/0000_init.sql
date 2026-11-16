CREATE TYPE "public"."staff_role" AS ENUM('owner', 'ceo', 'coo', 'management', 'legal', 'loan_officer');--> statement-breakpoint
CREATE TYPE "public"."staff_status" AS ENUM('invited', 'active', 'suspended', 'departed');--> statement-breakpoint
CREATE TYPE "public"."audit_actor_type" AS ENUM('staff', 'system', 'anonymous');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "rate_limit_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"step_up_at" timestamp with time zone,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "two_factor" (
	"id" text PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"user_id" text NOT NULL,
	"verified" boolean DEFAULT true,
	"failed_verification_count" integer DEFAULT 0,
	"locked_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"username" text,
	"display_username" text,
	"two_factor_enabled" boolean DEFAULT false,
	CONSTRAINT "user_email_unique" UNIQUE("email"),
	CONSTRAINT "user_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text,
	"state_id" integer NOT NULL,
	"character_name" text NOT NULL,
	"role" "staff_role" NOT NULL,
	"status" "staff_status" DEFAULT 'invited' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_staff_id" uuid,
	CONSTRAINT "staff_state_id_positive" CHECK ("staff"."state_id" > 0)
);
--> statement-breakpoint
CREATE TABLE "staff_invite" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_staff_id" uuid,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_event" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"occurred_at" timestamp (6) with time zone NOT NULL,
	"actor_type" "audit_actor_type" NOT NULL,
	"actor_staff_id" uuid,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"reason" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" text,
	"user_agent" text,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_invite" ADD CONSTRAINT "staff_invite_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "twoFactor_secret_idx" ON "two_factor" USING btree ("secret");--> statement-breakpoint
CREATE INDEX "twoFactor_userId_idx" ON "two_factor" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_state_id_uq" ON "staff" USING btree ("state_id");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_user_id_uq" ON "staff" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_invite_token_hash_uq" ON "staff_invite" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "staff_invite_staff_idx" ON "staff_invite" USING btree ("staff_id");--> statement-breakpoint
CREATE INDEX "audit_event_occurred_at_idx" ON "audit_event" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "audit_event_actor_idx" ON "audit_event" USING btree ("actor_staff_id");--> statement-breakpoint
CREATE INDEX "audit_event_target_idx" ON "audit_event" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "audit_event_action_idx" ON "audit_event" USING btree ("action");