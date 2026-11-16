-- Audit trail is append-only (SPEC §8). Rejected for every role, including the
-- table owner, so a compromised application connection cannot rewrite history.
-- Tampering at a higher privilege level is still detectable via the HMAC chain.

CREATE OR REPLACE FUNCTION audit_event_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_event is append-only (% rejected)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_event_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION audit_event_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_event_no_truncate
  BEFORE TRUNCATE ON audit_event
  FOR EACH STATEMENT EXECUTE FUNCTION audit_event_reject_mutation();
