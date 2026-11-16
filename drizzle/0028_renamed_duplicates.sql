-- A renamed customer's rows imported twice (docs/qa/QA-2026-10-13.md, "Later the same day"). The bank export prints a
-- person's current name on all their rows, old ones too, and the import used to tell rows apart by a hash that
-- included the name. When Cyan Oakhurst became Cyan Spencer, two rows already in the books (her 29 Sep down payment and
-- 6 Oct repayment on 118 Imagination Ct) came back under the new name and were posted again: cash $183,835 too high,
-- 1110 the same amount below zero, the tax memo $31,446 too high, a second mortgage for the down payment, and the
-- repayment linked twice. The import now ignores the name (`identityKey`); this removes what got in before.
--
-- A duplicate is a row identical to a row from an earlier import in everything except the initiator's name (same
-- State ID, second, amounts, wallets and comment). It is removed with its own bank posting; its mortgage, if it made
-- one, is retired into the original's (as a merge does), keeping the newer tablet paste. Anything else built on a
-- duplicate stops the migration, and the deploy, without changing anything. Running it again changes nothing.

CREATE TEMP TABLE renamed_duplicate ON COMMIT DROP AS
SELECT b.id, b.batch_id, b.posting_entry_id, (array_agg(a.id ORDER BY a.created_at, a.id))[1] AS original_id
  FROM bank_transaction b
  JOIN bank_transaction a
    ON a.wallet_id = b.wallet_id AND a.occurred_at = b.occurred_at AND a.direction = b.direction AND a.tx_type = b.tx_type
   AND a.amount_cents = b.amount_cents AND a.tax_cents = b.tax_cents AND a.tax_percent IS NOT DISTINCT FROM b.tax_percent
   AND a.source_wallet IS NOT DISTINCT FROM b.source_wallet AND a.target_wallet IS NOT DISTINCT FROM b.target_wallet
   AND a.initiator_state_id IS NOT DISTINCT FROM b.initiator_state_id AND a.comment = b.comment
   AND a.initiator_name IS DISTINCT FROM b.initiator_name
   AND a.batch_id <> b.batch_id
   AND (SELECT created_at FROM import_batch WHERE id = a.batch_id) < (SELECT created_at FROM import_batch WHERE id = b.batch_id)
 GROUP BY b.id, b.batch_id, b.posting_entry_id;
--> statement-breakpoint

CREATE TEMP TABLE renamed_mortgage ON COMMIT DROP AS
SELECT m.id AS dup_id, o.id AS into_id
  FROM mortgage m
  JOIN renamed_duplicate d ON d.id = m.origination_tx_id
  JOIN mortgage o ON o.origination_tx_id = d.original_id AND o.merged_into_id IS NULL;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM journal_entry e JOIN renamed_duplicate d ON d.id = e.bank_transaction_id
              WHERE e.id IS DISTINCT FROM d.posting_entry_id)
     OR EXISTS (SELECT 1 FROM journal_entry e JOIN renamed_duplicate d ON d.posting_entry_id = e.reverses_entry_id) THEN
    RAISE EXCEPTION 'renamed duplicates: a duplicate row was reclassified or has other entries; correct it by hand';
  END IF;
  IF EXISTS (SELECT 1 FROM mortgage_settlement s JOIN renamed_duplicate d ON d.id IN (s.in_tx_id, s.out_tx_id))
     OR EXISTS (SELECT 1 FROM loan_payment_link k JOIN renamed_duplicate d ON d.id = k.bank_transaction_id)
     OR EXISTS (SELECT 1 FROM loan l JOIN renamed_duplicate d ON d.id = l.disbursement_tx_id)
     OR EXISTS (SELECT 1 FROM commission_line c JOIN renamed_duplicate d ON d.id = c.source_tx_id)
     OR EXISTS (SELECT 1 FROM commission_payout p JOIN renamed_duplicate d ON d.id = p.bank_transaction_id) THEN
    RAISE EXCEPTION 'renamed duplicates: a duplicate row is paired, linked to a loan or counted for commission; correct it by hand';
  END IF;
  IF EXISTS (SELECT 1 FROM mortgage m JOIN renamed_duplicate d ON d.id = m.origination_tx_id
              WHERE NOT EXISTS (SELECT 1 FROM renamed_mortgage r WHERE r.dup_id = m.id)
                 OR m.funding_entry_id IS NOT NULL
                 OR EXISTS (SELECT 1 FROM mortgage_quote q WHERE q.mortgage_id = m.id)) THEN
    RAISE EXCEPTION 'renamed duplicates: a mortgage made from a duplicate has no original to merge into, or has bookings or a quote';
  END IF;
END $$;
--> statement-breakpoint

-- The duplicate mortgage: its tablet pastes go to the original, which takes the newer paste's details (a field
-- missing from it never erases one, as in a paste), then it is retired into the original.
UPDATE mortgage_snapshot s SET mortgage_id = r.into_id FROM renamed_mortgage r WHERE s.mortgage_id = r.dup_id;
--> statement-breakpoint
UPDATE mortgage_payment p SET mortgage_id = r.into_id FROM renamed_mortgage r
 WHERE p.mortgage_id = r.dup_id AND p.bank_transaction_id NOT IN (SELECT id FROM renamed_duplicate);
--> statement-breakpoint
UPDATE mortgage o SET
    buyer_name = coalesce(m.buyer_name, o.buyer_name),
    property_type = coalesce(m.property_type, o.property_type),
    land_count = coalesce(m.land_count, o.land_count),
    price_cents = coalesce(m.price_cents, o.price_cents),
    down_payment_cents = coalesce(m.down_payment_cents, o.down_payment_cents),
    loan_cents = coalesce(m.loan_cents, o.loan_cents),
    broker_interest_cents = coalesce(m.broker_interest_cents, o.broker_interest_cents),
    federal_interest_cents = coalesce(m.federal_interest_cents, o.federal_interest_cents),
    instalments = coalesce(m.instalments, o.instalments),
    term_months = coalesce(m.term_months, o.term_months),
    fed_rate_bp = coalesce(m.fed_rate_bp, o.fed_rate_bp),
    broker_rate_bp = coalesce(m.broker_rate_bp, o.broker_rate_bp),
    late_fee_cents = coalesce(m.late_fee_cents, o.late_fee_cents),
    grace_period_days = coalesce(m.grace_period_days, o.grace_period_days),
    broker_fee_cents = coalesce(m.broker_fee_cents, o.broker_fee_cents),
    agency_commission_cents = coalesce(m.agency_commission_cents, o.agency_commission_cents),
    owner_name = coalesce(m.owner_name, o.owner_name),
    agency_name = coalesce(m.agency_name, o.agency_name),
    agent_state_id = coalesce(m.agent_state_id, o.agent_state_id),
    agent_name = coalesce(m.agent_name, o.agent_name),
    officer_state_id = coalesce(m.officer_state_id, o.officer_state_id),
    officer_name = coalesce(m.officer_name, o.officer_name),
    officer_staff_id = coalesce(o.officer_staff_id, m.officer_staff_id),
    last_tablet_at = m.last_tablet_at,
    last_paid_count = coalesce(m.last_paid_count, o.last_paid_count),
    last_remaining_cents = coalesce(m.last_remaining_cents, o.last_remaining_cents),
    updated_at = now()
  FROM renamed_mortgage r JOIN mortgage m ON m.id = r.dup_id
 WHERE o.id = r.into_id AND m.last_tablet_at IS NOT NULL AND (o.last_tablet_at IS NULL OR m.last_tablet_at > o.last_tablet_at);
--> statement-breakpoint
UPDATE mortgage m SET merged_into_id = r.into_id, origination_tx_id = NULL, updated_at = now()
  FROM renamed_mortgage r WHERE m.id = r.dup_id;
--> statement-breakpoint
INSERT INTO mortgage_event (mortgage_id, at, kind, detail)
SELECT r.into_id, now(), 'merged', jsonb_build_object('fromAddress', m.address, 'mergedId', m.id, 'reason', 'Same down payment imported twice after the buyer changed name')
  FROM renamed_mortgage r JOIN mortgage m ON m.id = r.dup_id
UNION ALL
SELECT r.dup_id, now(), 'merged_into', jsonb_build_object('intoAddress', o.address, 'intoId', o.id, 'reason', 'Same down payment imported twice after the buyer changed name')
  FROM renamed_mortgage r JOIN mortgage o ON o.id = r.into_id;
--> statement-breakpoint

-- The duplicate rows and their postings. The ledger and raw bank rows are protected; lifted inside this transaction.
DELETE FROM mortgage_payment WHERE bank_transaction_id IN (SELECT id FROM renamed_duplicate);
--> statement-breakpoint
ALTER TABLE journal_line DISABLE TRIGGER journal_line_immutable;
--> statement-breakpoint
ALTER TABLE journal_entry DISABLE TRIGGER journal_entry_immutable;
--> statement-breakpoint
ALTER TABLE bank_transaction DISABLE TRIGGER bank_transaction_guard;
--> statement-breakpoint
DELETE FROM journal_line WHERE entry_id IN (SELECT posting_entry_id FROM renamed_duplicate);
--> statement-breakpoint
DELETE FROM journal_entry WHERE id IN (SELECT posting_entry_id FROM renamed_duplicate);
--> statement-breakpoint
DELETE FROM bank_transaction WHERE id IN (SELECT id FROM renamed_duplicate);
--> statement-breakpoint
ALTER TABLE bank_transaction ENABLE TRIGGER bank_transaction_guard;
--> statement-breakpoint
ALTER TABLE journal_entry ENABLE TRIGGER journal_entry_immutable;
--> statement-breakpoint
ALTER TABLE journal_line ENABLE TRIGGER journal_line_immutable;
--> statement-breakpoint

-- The Imports page counts them as already imported, as it would have.
UPDATE import_batch b SET new_count = b.new_count - n.c, duplicate_count = b.duplicate_count + n.c
  FROM (SELECT batch_id, count(*)::int AS c FROM renamed_duplicate GROUP BY batch_id) n
 WHERE b.id = n.batch_id;
