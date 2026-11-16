# Audit procedures (read-only)

Each script only reads. Run against production with:

    node scripts/with-prod-env.mjs pnpm exec tsx --conditions=react-server scripts/audit/<script>.ts

- `a-ledger.ts` — trial balance, postings, cash vs bank vs export header, gaps, tax rates, audit chain
- `a2-tax.ts` — tax withheld vs each State "Tax Payment" record (window since the previous record)
- `b-loans.ts` — receivable sub-ledger, instalment recalculation, levy, interest vs contract, fees, write-offs
- `c-mortgages.ts` — pass-through pairing, kept vs tablet, banker fee %, receivable
- `d-other.ts` — trial balance listing, commissions, categories, monthly P&L, app figures vs books
- `f-bugs.ts` — known game bugs quantified across the book
- `e-sources.ts` — what the app shows vs the source records: every loan's latest phone card (terms, State ID, tab,
  instalments paid, remaining, next payment and amount, first missed, missed count, default date), Portfolio health
  vs the phone, every mortgage's latest tablet agreement (terms, parties, Paid count, weekly, remaining, paid so far,
  repayment amounts), and history events vs their bank rows — each against the bank as it stood at the paste

Runs and findings: `docs/audit/AUDIT-2026-10-10.md`, `docs/qa/QA-2026-10-13.md` (the source reconciliation).
