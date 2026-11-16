-- Income from the old manual loans (docs/research/09): booked once from 1190.
INSERT INTO ledger_account (code, name, type, description) VALUES
  ('4020', 'Legacy manual loan income', 'income', 'Net result of the 2025–2026 manual loans (repaid minus lent), recognised when they were all finished')
ON CONFLICT (code) DO NOTHING;
