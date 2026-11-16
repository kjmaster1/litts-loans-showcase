-- Repayments filed under another buyer's mortgage (2026-10-28, Zion's report). The server renumbers houses and gives
-- old numbers to other houses: 115 North Rockford Dr had been Noel Dunmore's, then became Cheri Bush's, and her
-- 24 Oct repayment was linked to his mortgage because repayments were linked by address alone. The sync now links
-- them by who paid (`repaymentMortgage`); this unlinks the ones it would have filed elsewhere, so the next sync (the
-- next import or tablet paste) links them to the payer's own mortgage and learns its new address.
--
-- A misfiled repayment is one paid by someone other than the mortgage's buyer who has a mortgage of their own. Only
-- the link is removed: the bank row, its posting and its pairing with the State's transfer don't depend on it. A link
-- with its own booking (company-funded) or on a completed mortgage stops the migration, and the deploy, with nothing
-- changed. Running it again changes nothing.

CREATE TEMP TABLE misfiled_repayment ON COMMIT DROP AS
SELECT p.bank_transaction_id AS id, p.entry_id, m.status
  FROM mortgage_payment p
  JOIN bank_transaction b ON b.id = p.bank_transaction_id
  JOIN mortgage m ON m.id = p.mortgage_id
 WHERE b.initiator_state_id IS NOT NULL AND m.buyer_state_id IS NOT NULL
   AND b.initiator_state_id <> m.buyer_state_id
   AND EXISTS (SELECT 1 FROM mortgage o WHERE o.merged_into_id IS NULL AND o.buyer_state_id = b.initiator_state_id);
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM misfiled_repayment WHERE entry_id IS NOT NULL OR status = 'completed') THEN
    RAISE EXCEPTION 'renumbered repayments: a misfiled repayment has its own booking or is on a completed mortgage; correct it by hand';
  END IF;
END $$;
--> statement-breakpoint

DELETE FROM mortgage_payment WHERE bank_transaction_id IN (SELECT id FROM misfiled_repayment);
