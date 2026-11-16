-- Ledger integrity rules enforced by the database (docs/design/LEDGER.md).

-- 1. Journal is append-only: corrections are reversal entries, never edits.
CREATE OR REPLACE FUNCTION ledger_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% rejected)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER journal_entry_immutable BEFORE UPDATE OR DELETE ON journal_entry
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER journal_entry_no_truncate BEFORE TRUNCATE ON journal_entry
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER journal_line_immutable BEFORE UPDATE OR DELETE ON journal_line
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER journal_line_no_truncate BEFORE TRUNCATE ON journal_line
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_reject_mutation();
--> statement-breakpoint

-- 2. Every entry balances (Σ debit = Σ credit) and has ≥ 2 lines. Checked at
--    COMMIT (deferred) so lines can be inserted one by one inside a transaction.
CREATE OR REPLACE FUNCTION journal_entry_assert_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target uuid;
  d bigint; c bigint; n int;
BEGIN
  -- Record fields are resolved per table at plan time, so branch explicitly.
  IF TG_TABLE_NAME = 'journal_entry' THEN
    target := NEW.id;
  ELSE
    target := NEW.entry_id;
  END IF;
  SELECT coalesce(sum(debit_cents), 0), coalesce(sum(credit_cents), 0), count(*)
    INTO d, c, n FROM journal_line WHERE entry_id = target;
  IF n < 2 THEN
    RAISE EXCEPTION 'journal entry % has % line(s); at least 2 required', target, n USING ERRCODE = 'check_violation';
  END IF;
  IF d <> c THEN
    RAISE EXCEPTION 'journal entry % is unbalanced: debits % <> credits %', target, d, c USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journal_line_balanced AFTER INSERT ON journal_line
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION journal_entry_assert_balanced();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journal_entry_has_lines AFTER INSERT ON journal_entry
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION journal_entry_assert_balanced();
--> statement-breakpoint

-- 3. Raw bank data is immutable; only classification columns may change.
CREATE OR REPLACE FUNCTION bank_transaction_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'bank_transaction rows cannot be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.batch_id, NEW.wallet_id, NEW.occurred_at, NEW.direction, NEW.tx_type, NEW.amount_cents, NEW.tax_cents,
      NEW.tax_percent, NEW.source_wallet, NEW.target_wallet, NEW.initiator_name, NEW.initiator_state_id,
      NEW.comment, NEW.fingerprint, NEW.occurrence)
     IS DISTINCT FROM
     (OLD.batch_id, OLD.wallet_id, OLD.occurred_at, OLD.direction, OLD.tx_type, OLD.amount_cents, OLD.tax_cents,
      OLD.tax_percent, OLD.source_wallet, OLD.target_wallet, OLD.initiator_name, OLD.initiator_state_id,
      OLD.comment, OLD.fingerprint, OLD.occurrence) THEN
    RAISE EXCEPTION 'raw bank_transaction columns are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER bank_transaction_guard BEFORE UPDATE OR DELETE ON bank_transaction
  FOR EACH ROW EXECUTE FUNCTION bank_transaction_guard();
--> statement-breakpoint

-- 4. Chart of accounts (reference data; keep in sync with src/domain/ledger/accounts.ts).
INSERT INTO ledger_account (code, name, type, description) VALUES
  ('1000', 'Cash — business wallet', 'asset', 'Business bank wallet 69811362'),
  ('1100', 'Loans receivable — principal', 'asset', 'Principal outstanding on private loans'),
  ('1110', 'Mortgage pass-through clearing', 'asset', 'Mortgage money in transit to/from the State'),
  ('1190', 'Legacy manual loans clearing', 'asset', 'Pre-system manual loans; credit balance = net interest earned'),
  ('1900', 'Suspense — unclassified', 'asset', 'Bank rows awaiting classification'),
  ('2200', 'Loans from staff', 'liability', 'Money staff lent to the company'),
  ('3000', 'Capital contributed', 'equity', 'Owner/partner investment'),
  ('3200', 'Capital returned & distributions', 'equity', 'Investment paybacks and profit distributions'),
  ('4000', 'Loan interest income', 'income', 'Broker interest on private loans'),
  ('4010', 'Early-repayment interest income', 'income', 'Interest charged by the game on early repayments'),
  ('4100', 'Mortgage broker fee income', 'income', 'Bank/broker fee kept at mortgage origination'),
  ('4110', 'Mortgage broker interest income', 'income', 'Broker share of mortgage instalments'),
  ('4200', 'Origination fee income', 'income', 'Loan broker fee charged at disbursement'),
  ('4300', 'Recoveries', 'income', 'Seizures and sales of repossessed collateral'),
  ('4900', 'Other income', 'income', NULL),
  ('5000', 'Commission expense', 'expense', 'Staff commission on loans and mortgages'),
  ('5050', 'Staff pay & bonuses', 'expense', NULL),
  ('5200', 'Tax withheld at source', 'expense', 'Tax the bank withholds from lending income'),
  ('5400', 'Legal fees', 'expense', NULL),
  ('5450', 'Collection & repossession costs', 'expense', 'Towing, impound, registration of repossessed assets'),
  ('5500', 'Marketing', 'expense', NULL),
  ('5600', 'Refunds & reimbursements', 'expense', NULL),
  ('5900', 'Other expenses', 'expense', NULL),
  ('9000', 'Tax escrow — withheld, not yet reported', 'memo', 'Memo: tax withheld minus monthly Tax Payment records'),
  ('9090', 'Tax escrow — memo contra', 'memo', 'Memo contra account');
