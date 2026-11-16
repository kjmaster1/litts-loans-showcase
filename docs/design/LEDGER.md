# Ledger & bank import design (Phase 2)

## Principles

- **Double entry, integer cents.** Every journal entry has ≥ 2 lines; Σ debits =
  Σ credits is enforced by a *deferred constraint trigger* (checked at commit),
  so an unbalanced entry cannot exist.
- **Immutable journal.** UPDATE/DELETE on entries and lines are rejected by
  trigger. Corrections are *reversal* entries plus a new entry.
- **Raw bank rows are immutable.** Only their classification fields change, and
  every change goes through a reversal + repost with an audit event.
- **Balances are derived** (sums over lines), never stored.
- **Cash must reconcile.** After importing a full-history export, the ledger's
  cash account equals the export header's balance (sample: **$185,331**).

## Chart of accounts

| Code | Account | Type |
|---|---|---|
| 1000 | Cash — business wallet 69811362 | Asset |
| 1100 | Loans receivable — principal | Asset |
| 1110 | Mortgage pass-through clearing | Asset |
| 1190 | Legacy manual loans clearing | Asset |
| 1900 | Suspense — unclassified | Asset |
| 2200 | Loans from staff | Liability |
| 3000 | Capital contributed | Equity |
| 3200 | Capital returned & distributions | Equity |
| 4000 | Loan interest income | Income |
| 4010 | Early-repayment interest income | Income |
| 4100 | Mortgage broker fee income | Income |
| 4110 | Mortgage broker interest income | Income |
| 4200 | Origination fee income | Income |
| 4300 | Recoveries (seizures, collateral sales) | Income |
| 4900 | Other income | Income |
| 5000 | Commission expense | Expense |
| 5050 | Staff pay & bonuses | Expense |
| 5150 | Interest paid on staff loans | Expense |
| 5200 | Tax withheld at source | Expense |
| 5400 | Legal fees | Expense |
| 5450 | Collection & repossession costs | Expense |
| 5500 | Marketing | Expense |
| 5600 | Refunds & reimbursements | Expense |
| 5900 | Other expenses | Expense |
| 9000 | Tax escrow — withheld, not yet reported (memo) | Memo |
| 9090 | Tax escrow — memo contra | Memo |

(Phase 3 adds 1150 Allowance for credit losses, 5100 State loan levy, 5300 Credit
losses; Phase 5 adds 2000 Commissions payable.)

## Tax treatment

The bank withholds `Tax ($)` before money lands. Two cases:

1. **Lending income rows** (loan principal/interest/fees): the tax is a cost the
   company bears → `Dr Cash (A−T)`, `Dr 5200 Tax withheld (T)`, `Cr <account> (A)`.
2. **Mortgage pass-through rows** (down payment & fees, mortgage repayments): the
   tax is the buyer's property tax / federal interest, not the company's cost →
   `Dr Cash (A−T)`, `Cr 1110 clearing (A−T)`.

Both also post a memo entry `Dr 9000 / Cr 9090 (T)`. The monthly "Tax Payment"
row (a record only — the business account never pays it) posts `Dr 9090 /
Cr 9000`, so account 9000's balance shows tax withheld but not yet reported, and
the import can flag months where the record doesn't match what was withheld.

## Classification

Rules are ordered, pure, versioned (`RULESET_VERSION`) and unit-tested against
every row of the anonymised fixture. Each result has a confidence:

- **certain** — game-generated wording (e.g. `Subscription payment Loan Agreement…`).
- **heuristic** — manual comment matched by keywords (e.g. "Vehicle Sale").
- **tag** — manual comment starting with an explicit tag, e.g. `[REPO]`.
- **unclassified** — no rule → `1900 Suspense`, appears in the review queue.

Recommended comment tags for manual transactions (shown in the app):
`[REPO]` collateral sale · `[TOW]` repossession/collection cost · `[LEGAL]` legal
fee · `[COMM]` commission · `[REFUND]` refund · `[CAPITAL]` investment in ·
`[PAYBACK]` investment returned · `[STAFFLOAN]` staff loan in/out ·
`[MARKETING]` · `[OTHER]`.

## Mortgage pass-through settlement

Mortgage money moves in pairs at the same timestamp for the same address:

- `"<addr>: Down Payment & Fees"` (in) ↔ `"<addr>: Property Loan & Fees"` (out)
- `"<addr>: Loan Repayment"` (in) ↔ `"<addr>: Loan Repayment"` (out → 69794349); the last instalment reads `"<addr>: Final Loan Repayment"` on both

Each leg posts to 1110 clearing. When both legs are present, a settlement entry
moves the residual to income — broker fee (4100) for origination, broker interest
(4110) for repayments. Verified on 117 Invention Ct: 168,560 − 113,409 =
**55,151 = the broker fee on the tablet**.

## Legacy manual loans (2025 → mid-2026)

Disbursed via "Employee Pay: … Loan …" and repaid via "Charge: Loan #n …" with
principal and interest mixed. Both post to 1190 clearing. All legacy loans are
complete, so 1190's credit balance is the net interest earned; the app shows it
and lets an executive recognise it as income (sensitive action) rather than
guessing a split.

## Old staff loans (research/11)

Staff once lent the company money (2200); all finished, no longer done. One sensitive
action (Finance → *Old staff loans*, fresh 2FA + reason) clears 2200, per lender: money in
is credited to whoever paid it in; a repayment to whoever made it if they lent money,
else to the owner of the wallet it went to. A lender never shown repaid → `Dr 2200 /
Cr 3200` (settled outside the business wallet); repaid beyond what they lent →
`Dr 5150 / Cr 2200` (interest). Production on 2026-10-10: Cove Holloway $5,150 and
Sage Dunmore $9,367 settled outside; Zion Pemberton $5,814 interest.

## Import pipeline

1. **Upload** (Management+, ≤ 5 MB, must be a real xlsx) → parse server-side.
2. **Validate**: wallet must be 69811362; times are UTC whatever the header's `TIMEZONE` says (ADR 0004); every row
   parsed or rejected with a reason.
3. **De-duplicate**: a row is already imported when a stored row of the wallet matches it in every raw field
   **except the initiator's name** (`identityKey`, counted for identical rows). The export prints a person's
   current name on all their rows, old ones too: when the name was part of the match, a rename imported two rows
   a second time (QA 2026-10-13, "Later the same day"). Rows still store a fingerprint (SHA-256 of the canonical
   raw row, name included); identical rows within a file get an occurrence index and `(fingerprint, occurrence)`
   stays unique. Overlapping date-range exports are idempotent.
4. **Preview** (staged, not posted): new vs already-imported, category counts,
   unclassified rows, tax-record mismatches. Two red warnings (never a block, owner 2026-10-13): the books' cash
   as at the export's last row, with this file in, differs from the export's balance (the books start from the
   account's first transaction, so it always matches unless something is missing or doubled); and new rows dated
   before the latest row already in the books (an export never adds to the past).
5. **Commit**: one transaction — insert batch + rows, post journal entries, audit.
6. **Reconcile**: ledger cash vs the export's reported balance.
