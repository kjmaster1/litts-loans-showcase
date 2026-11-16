-- Bank export times are UTC, not the "UTC-5" the export's header claims (docs/decisions/0004-bank-export-times-are-utc.md).
-- Every bank time imported so far is 5 hours late. Move it, and every stored time copied from it, 5 hours earlier.
-- Nothing else changes: amounts, links, categories and row fingerprints stay as they are. One transaction:
-- if any check below fails, nothing is changed and the deploy stops.

-- 0. Stop if a commission decision would end up on the wrong side of the scheme start (Mon 12 Oct 00:00 UK =
--    11 Oct 23:00 UTC): loan interest the closed catch-up period never counted, or a payout already matched as
--    after the scheme started. Rows stored in the 5 hours after the start are the ones that move before it.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM bank_transaction b
      JOIN loan_payment_link k ON k.bank_transaction_id = b.id AND k.role IN ('interest', 'early_interest', 'late_fee')
     WHERE b.occurred_at >= timestamptz '2026-10-11 23:00:00+00' AND b.occurred_at < timestamptz '2026-10-12 04:00:00+00'
       AND EXISTS (SELECT 1 FROM commission_week w WHERE w.week_key = 'catch-up' AND w.status = 'closed')
       AND NOT EXISTS (SELECT 1 FROM commission_line c WHERE c.source_tx_id = b.id)
  ) THEN
    RAISE EXCEPTION 'bank time correction: loan interest would move into the closed catch-up period without being counted';
  END IF;
  IF EXISTS (
    SELECT 1 FROM bank_transaction b JOIN commission_payout p ON p.bank_transaction_id = b.id
     WHERE b.occurred_at >= timestamptz '2026-10-11 23:00:00+00' AND b.occurred_at < timestamptz '2026-10-12 04:00:00+00'
  ) THEN
    RAISE EXCEPTION 'bank time correction: a commission payout would move to before the scheme start';
  END IF;
END $$;
--> statement-breakpoint

-- The ledger and raw bank rows are protected against edits; this one correction lifts that inside the transaction.
ALTER TABLE journal_entry DISABLE TRIGGER journal_entry_immutable;
--> statement-breakpoint
ALTER TABLE bank_transaction DISABLE TRIGGER bank_transaction_guard;
--> statement-breakpoint

-- 1. Times copied from a bank row: matched to the second against the (not yet moved) bank time.
--    Times set by the app itself ("now", week ends) never equal a bank second and are left alone.
UPDATE loan_offer o SET funded_at = o.funded_at - interval '5 hours'
  FROM loan l JOIN bank_transaction b ON b.id = l.disbursement_tx_id
 WHERE o.loan_id = l.id AND o.funded_at = b.occurred_at;
--> statement-breakpoint
UPDATE loan l SET opened_at = l.opened_at - interval '5 hours'
  FROM bank_transaction b
 WHERE b.id = l.disbursement_tx_id AND l.opened_at = b.occurred_at;
--> statement-breakpoint
UPDATE loan l SET completed_at = l.completed_at - interval '5 hours'
 WHERE EXISTS (SELECT 1 FROM loan_payment_link k JOIN bank_transaction b ON b.id = k.bank_transaction_id
                WHERE k.loan_id = l.id AND b.occurred_at = l.completed_at);
--> statement-breakpoint
-- Default dates estimated from the last payment (or the start) are that bank time + whole days. Those from the
-- card's "First missed payment" date are already right, and are never a whole number of days from a late bank time.
UPDATE loan l SET first_default_at = l.first_default_at - interval '5 hours'
 WHERE l.first_default_at IS NOT NULL AND EXISTS (
   SELECT 1 FROM bank_transaction b
    WHERE (b.id = l.disbursement_tx_id OR b.id IN (SELECT k.bank_transaction_id FROM loan_payment_link k WHERE k.loan_id = l.id))
      AND l.first_default_at > b.occurred_at
      AND mod(extract(epoch FROM l.first_default_at - b.occurred_at)::numeric, 86400) = 0);
--> statement-breakpoint
UPDATE mortgage m SET originated_at = m.originated_at - interval '5 hours'
  FROM bank_transaction b
 WHERE b.id = m.origination_tx_id AND m.originated_at = b.occurred_at;
--> statement-breakpoint
UPDATE journal_entry e SET effective_at = e.effective_at - interval '5 hours'
 WHERE e.description NOT LIKE 'Commission —%'
   AND EXISTS (SELECT 1 FROM bank_transaction b WHERE b.occurred_at = e.effective_at);
--> statement-breakpoint
UPDATE import_batch SET first_tx_at = first_tx_at - interval '5 hours', last_tx_at = last_tx_at - interval '5 hours'
 WHERE kind = 'bank_xlsx';
--> statement-breakpoint
-- Previews staged before this change carry the old times; they have to be uploaded again.
DELETE FROM import_staging;
--> statement-breakpoint

-- 2. The bank rows themselves.
UPDATE bank_transaction SET occurred_at = occurred_at - interval '5 hours';
--> statement-breakpoint

ALTER TABLE bank_transaction ENABLE TRIGGER bank_transaction_guard;
--> statement-breakpoint
ALTER TABLE journal_entry ENABLE TRIGGER journal_entry_immutable;
--> statement-breakpoint

-- 3. The evidence must now hold: no export contains a row from after it was imported. Only real exports count —
--    ones holding rows from before their import; a test file made up entirely of future rows proves nothing.
--    (Applied in production 2026-10-13; this narrowing, for development databases, came after.)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM import_batch WHERE kind = 'bank_xlsx' AND last_tx_at > created_at AND first_tx_at <= created_at) THEN
    RAISE EXCEPTION 'bank time correction: an export still has a row from after it was imported';
  END IF;
END $$;
