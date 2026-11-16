-- Least-privilege database roles (SPEC §8; review 2026-10-13). Until now the app, the backup and the
-- health check all connected as the database owner, so whoever held the app's connection string could
-- switch off the triggers that keep the ledger and audit trail append-only.
--
--   litts_app       what the running app connects as: read and write rows, nothing else. No DDL, no
--                   TRUNCATE, and no UPDATE/DELETE on append-only tables (the triggers stay as a
--                   second line), so it can't alter history even with a stolen connection string.
--   litts_readonly  the nightly backup, the audit anchor, the daily health check and the restore drill.
--
-- Both are created NOLOGIN, so this migration changes nothing on its own. The owner gives each a
-- password in the Neon SQL editor and swaps the connection strings (docs/operations/DEPLOYING.md,
-- "Database roles"). Migrations keep running as the owner. Roles belong to the whole server, so a
-- re-run (or a second database on the same server, as in tests) finds them already there.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'litts_app') THEN
    CREATE ROLE litts_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'litts_readonly') THEN
    CREATE ROLE litts_readonly NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint

-- The app: rows only.
GRANT USAGE ON SCHEMA public TO litts_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO litts_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO litts_app;
--> statement-breakpoint
-- Append-only tables: rows are added, never changed or removed.
REVOKE UPDATE, DELETE ON
  audit_event, journal_entry, journal_line, loan_event, mortgage_event, loan_collection_action,
  loan_adjustment, commission_line, commission_award, company_setting
FROM litts_app;
--> statement-breakpoint
-- Raw bank rows can be reclassified (an UPDATE the trigger limits to the classification columns), and an
-- allowance reading can be voided, but neither is ever deleted.
REVOKE DELETE ON bank_transaction, allowance_reading FROM litts_app;
--> statement-breakpoint

-- Backups and checks: read everything, including the migration journal pg_dump needs.
GRANT USAGE ON SCHEMA public TO litts_readonly;
--> statement-breakpoint
GRANT SELECT ON ALL TABLES IN SCHEMA public TO litts_readonly;
--> statement-breakpoint
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO litts_readonly;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_namespace WHERE nspname = 'drizzle') THEN
    GRANT USAGE ON SCHEMA drizzle TO litts_readonly;
    GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO litts_readonly;
    GRANT SELECT ON ALL SEQUENCES IN SCHEMA drizzle TO litts_readonly;
  END IF;
END
$$;
--> statement-breakpoint

-- Tables added by later migrations (run as the owner) get the same grants. A new append-only table must
-- also REVOKE UPDATE, DELETE from litts_app in its own migration; a test checks this.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO litts_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO litts_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO litts_readonly;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON SEQUENCES TO litts_readonly;
