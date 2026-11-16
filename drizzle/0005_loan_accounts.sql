-- Accounts introduced by the loans module (docs/design/LOANS.md §Accounting).
INSERT INTO ledger_account (code, name, type, description) VALUES
  ('5100', 'State loan levy', 'expense', 'The State''s share of each principal instalment (the company bears it)'),
  ('5300', 'Credit losses', 'expense', 'Principal written off on defaulted loans');
--> statement-breakpoint
-- Loan events are a history: append-only like the audit log.
CREATE TRIGGER loan_event_immutable BEFORE UPDATE OR DELETE ON loan_event
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_mutation();
