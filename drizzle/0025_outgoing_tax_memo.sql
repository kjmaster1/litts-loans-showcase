-- Tax on a payment going out was the recipient's, not Litt's (QA 2026-10-13; domain/ledger/posting.ts): the business
-- paid the full amount and no State "Tax Payment" record ever includes it. The old rule still put it in the tax memo
-- (9000 "withheld, not yet reported"), where it could never clear. Re-post each such row the way a reclassification
-- does: reverse its posting and post it again without the memo lines. Production: one row (a $3,500 flyer invoice,
-- May 2025, taxed $167). Rows already posted without the memo are left alone, so running this again changes nothing.
DO $$
DECLARE
  r record;
  rev uuid;
  fresh uuid;
BEGIN
  FOR r IN
    SELECT b.id, b.posting_entry_id, b.occurred_at, b.comment, b.tx_type
      FROM bank_transaction b
     WHERE b.direction = 'out' AND b.tax_cents > 0 AND b.posting_entry_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM journal_line l WHERE l.entry_id = b.posting_entry_id AND l.account_code = '9000')
  LOOP
    rev := gen_random_uuid();
    fresh := gen_random_uuid();
    INSERT INTO journal_entry (id, effective_at, kind, description, bank_transaction_id, reverses_entry_id, reason)
      VALUES (rev, r.occurred_at, 'reversal', 'Reversal (tax on a payment going out is the recipient''s)', r.id, r.posting_entry_id,
              'QA 2026-10-13: tax on outgoing payments is not the company''s to report');
    INSERT INTO journal_line (entry_id, account_code, debit_cents, credit_cents, memo)
      SELECT rev, account_code, credit_cents, debit_cents, memo FROM journal_line WHERE entry_id = r.posting_entry_id;
    INSERT INTO journal_entry (id, effective_at, kind, description, bank_transaction_id, reason)
      VALUES (fresh, r.occurred_at, 'bank_posting', coalesce(nullif(left(btrim(r.comment), 300), ''), r.tx_type), r.id,
              'QA 2026-10-13: tax on outgoing payments is not the company''s to report');
    INSERT INTO journal_line (entry_id, account_code, debit_cents, credit_cents, memo)
      SELECT fresh, account_code, debit_cents, credit_cents, memo FROM journal_line
       WHERE entry_id = r.posting_entry_id AND account_code NOT IN ('9000', '9090');
    UPDATE bank_transaction SET posting_entry_id = fresh WHERE id = r.id;
  END LOOP;
END $$;
