-- Finishes the bank-time correction of migration 0024 (ADR 0004; QA 2026-10-13). A loan's "disbursed" event and a
-- mortgage's "originated" event are dated with the bank row's time, so they were stored 5 hours late as well — but the
-- event tables are append-only and 0024 left them alone. Match each to its own bank row (already corrected) to the
-- second, 5 hours on, and move it back. Production: 85 loan events, 29 mortgage events. Events already at their bank
-- time are left alone, so running this again changes nothing.
ALTER TABLE loan_event DISABLE TRIGGER loan_event_immutable;
--> statement-breakpoint
ALTER TABLE mortgage_event DISABLE TRIGGER mortgage_event_immutable;
--> statement-breakpoint
UPDATE loan_event e SET at = b.occurred_at
  FROM loan l JOIN bank_transaction b ON b.id = l.disbursement_tx_id
 WHERE e.loan_id = l.id AND e.kind = 'disbursed' AND e.at = b.occurred_at + interval '5 hours';
--> statement-breakpoint
UPDATE mortgage_event e SET at = b.occurred_at
  FROM mortgage m JOIN bank_transaction b ON b.id = m.origination_tx_id
 WHERE e.mortgage_id = m.id AND e.kind = 'originated' AND e.at = b.occurred_at + interval '5 hours';
--> statement-breakpoint
ALTER TABLE mortgage_event ENABLE TRIGGER mortgage_event_immutable;
--> statement-breakpoint
ALTER TABLE loan_event ENABLE TRIGGER loan_event_immutable;
