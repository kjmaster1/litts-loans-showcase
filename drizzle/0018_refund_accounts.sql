-- Audit 2026-10-10 (docs/audit): refunds of game errors reduce the income they reverse.
INSERT INTO ledger_account (code, name, type, description) VALUES
  ('4390', 'Refunds to borrowers (game errors)', 'income', 'Money given back to borrowers the game overcharged; reduces loan income and sits on the loan (audit F3)');
