-- A mortgage's final instalment (2026-11-06, Zion's report). The game words the last instalment
-- "<addr>: Final Loan Repayment" instead of "<addr>: Loan Repayment", which the app didn't know: both legs of
-- 104 Forum Dr, Apt 1F (5 Nov) were stored unclassified, with $404 left in Needs review (1900), $115 of tax booked as
-- Litt's expense (5200), and the mortgage stuck at 4 of 5. The classifier knows the wording now; this re-files the
-- rows stored before it did, the way a reclassification does: the posting is reversed and a new one made, both dated
-- at the transaction's time. Pairing the legs, linking the payment and completing the mortgage are left to the next
-- bank import, which already picks up legs waiting for a partner.
--
-- The new lines mirror `postingLines` for mortgage.repayment_in/out (tests/integration/final-repayment.test.ts compares
-- them). A row with this wording that isn't unclassified (someone filed it by hand), isn't a transfer, or went anywhere
-- but the State stops the migration, and the deploy, with nothing changed. Running it again changes nothing.

CREATE TEMP TABLE final_repayment ON COMMIT DROP AS
SELECT b.id, b.posting_entry_id, b.occurred_at, b.comment, b.direction, b.amount_cents, b.tax_cents, b.tx_type, b.target_wallet, b.category,
       gen_random_uuid() AS reversal_id, gen_random_uuid() AS entry_id
  FROM bank_transaction b
 WHERE b.comment ~ ': Final Loan Repayment\s*$'
   AND b.category NOT IN ('mortgage.repayment_in', 'mortgage.repayment_out');
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM final_repayment
     WHERE category <> 'unclassified'
        OR tx_type <> 'transfer'
        OR posting_entry_id IS NULL
        OR (direction = 'in' AND tax_cents >= amount_cents)
        OR (direction = 'out' AND target_wallet IS DISTINCT FROM '69794349')
  ) THEN
    RAISE EXCEPTION 'final repayments: a row was filed by hand or isn''t a mortgage instalment; correct it by hand';
  END IF;
END $$;
--> statement-breakpoint

INSERT INTO journal_entry (id, effective_at, kind, description, bank_transaction_id, reverses_entry_id, reason)
SELECT reversal_id, occurred_at, 'reversal'::journal_entry_kind,
       CASE WHEN direction = 'in' THEN 'Reversal (reclassified to Mortgage instalment (in))' ELSE 'Reversal (reclassified to Mortgage instalment (to State))' END,
       id, posting_entry_id, 'Migration 0035: the game words a mortgage''s last instalment "Final Loan Repayment"'
  FROM final_repayment
UNION ALL
SELECT entry_id, occurred_at, 'bank_posting'::journal_entry_kind, left(trim(comment), 300),
       id, NULL::uuid, 'Migration 0035: the game words a mortgage''s last instalment "Final Loan Repayment"'
  FROM final_repayment;
--> statement-breakpoint

INSERT INTO journal_line (entry_id, account_code, debit_cents, credit_cents, memo)
SELECT f.reversal_id, l.account_code, l.credit_cents, l.debit_cents, l.memo
  FROM journal_line l
  JOIN final_repayment f ON f.posting_entry_id = l.entry_id;
--> statement-breakpoint

INSERT INTO journal_line (entry_id, account_code, debit_cents, credit_cents, memo)
SELECT f.entry_id, v.account, v.debit, v.credit, v.memo
  FROM final_repayment f
 CROSS JOIN LATERAL (VALUES
   ('1000', f.amount_cents - f.tax_cents, 0::bigint, NULL::text),
   ('1110', 0::bigint, f.amount_cents - f.tax_cents, NULL::text),
   ('9000', f.tax_cents, 0::bigint, 'Tax withheld (memo)'),
   ('9090', 0::bigint, f.tax_cents, 'Tax withheld (memo)')
 ) AS v(account, debit, credit, memo)
 WHERE f.direction = 'in' AND (v.debit > 0 OR v.credit > 0);
--> statement-breakpoint

INSERT INTO journal_line (entry_id, account_code, debit_cents, credit_cents, memo)
SELECT f.entry_id, v.account, v.debit, v.credit, NULL
  FROM final_repayment f
 CROSS JOIN LATERAL (VALUES
   ('1110', f.amount_cents, 0::bigint),
   ('1000', 0::bigint, f.amount_cents)
 ) AS v(account, debit, credit)
 WHERE f.direction = 'out';
--> statement-breakpoint

UPDATE bank_transaction b
   SET category = CASE WHEN f.direction = 'in' THEN 'mortgage.repayment_in' ELSE 'mortgage.repayment_out' END,
       confidence = 'certain',
       ruleset_version = 2,
       posting_entry_id = f.entry_id
  FROM final_repayment f
 WHERE b.id = f.id;
