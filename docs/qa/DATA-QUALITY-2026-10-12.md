# Data quality: the "Sale Agreement - Financed" mortgage (2026-10-12)

## What happened

On 12 Oct 2026 at 05:13 a tablet paste created a mortgage whose address was
**"Sale Agreement - Financed"** (buyer Onyx Sutcliffe #9408, officer Zion Pemberton). It had a
price, an agency commission and "5 weekly payments", but no down payment, loan, rates or bank
money, and was shown as "Funded by Litt's". A re-paste at 05:14 updated the same bad record.
The real mortgage, **107 Amarillo Vista**, was pasted correctly at 05:15/05:16 and matched its
bank origination later. The bad record had no bank money, payments, quote or collections.

Three gaps lined up (read from the stored snapshots, `mortgage_snapshot` 29–30):

1. **Parser.** The copy started three lines too high, at the tablet's screen heading and tabs
   ("Sale Agreement - Financed", "PROPERTIES", "PAYMENTS"). The parser took line 1 as the address.
2. **No hard checks on new records.** "Loan details" was collapsed on the tablet, so the paste had
   no down payment or loan. The app still created a mortgage, showing only a soft "No loan amount."
   warning. With no fed rate it inferred "company-funded".
3. **No duplicate guard and no undo.** The same buyer already had a mortgage at the same price,
   agency and officer, but the preview offered a one-click save. There was no in-app way to retire
   a mistaken mortgage.

## What changed (owner's choices, 2026-10-12)

| Safeguard | Where |
|---|---|
| Parser finds the real address (the first header line that starts with a house number); lines above it are skipped and shown in the preview. All 34 live addresses start with a number. | `domain/mortgages/parse-tablet.ts` (`looksLikeAddress`, `skippedLines`, `addressRecognised`) |
| A paste with no recognisable address never matches or renames a mortgage by address. | `server/mortgages/tablet.ts` `match()` |
| **Refuse** a new mortgage record unless it has an address, a buyer State ID, a down payment and loan (Loan details open) and a payment count. Updates to known mortgages may still be partial. Checked again at commit. | `problemsForNewMortgage` (`domain/mortgages/identity.ts`) |
| **Duplicate guard:** a would-be new agreement whose buyer has a mortgage at the same price or loan, or one not pasted yet, must be resolved in the preview: update that mortgage, add as new, or skip. | `duplicateCandidates`; commit `decisions` |
| **Merge a duplicate mortgage** (Management+, step-up + reason, audited `mortgages.merged`). Only a record with no bank money can be merged away; one with a collections log is refused (append-only). Its pastes and quote move to the real record; `merged_into_id` hides it; old links redirect. A record whose address isn't an address shows a red alert. | `server/mortgages/service.ts` `mergeMortgage`; mortgage page |
| **Loan cards, same rules:** a card with no loan in the bank data needs an explicit "Add as a new loan" (no default), and only a card stating its amount may start one (no estimated principal). The same card twice in one paste counts once. | `domain/loans/match.ts` (`problemForNewLoan`, `duplicate_card`); `server/loans/paste.ts` |
| **Retire a card-only loan** (Management+, step-up + reason): merge it into the same borrower's loan (cards, collateral and offer move) or retire it as a mistake. Migration 0022: `loan.retired_at`, `loan.merged_into_id`; the DB only lets a loan without a disbursement be retired. Every loan query uses `liveLoan`. | `server/loans/service.ts` `retireCardOnlyLoan` |
| **Unconfirmed-record alert:** a tablet-only mortgage or card-only loan created over 24 h before the newest imported bank row (the bank has moved past it, yet no money) shows on the dashboard to-do list, in the bell (Management+) and in the daily health-check email. (A fixed "3 days" would false-alarm on weekly bank imports.) | `server/data-quality.ts`, `scripts/ops/health-check.mjs` |
| Paste box says where to start and end the copy and to open Loan details first. | `mortgages/import/tablet-workflow.tsx` |

Permission: `records.merge` (Management+, sensitive). SPEC §2 updated.

## Cleaning up the live record

Done in the app, not by script (step-up and audit trail): open the "Sale Agreement - Financed"
mortgage → **Duplicate record?** → Merge… → choose **107 Amarillo Vista** → reason → enter an
authenticator code.

**Done 12 Oct 2026, 10:24 UTC** by the owner. Checked read-only on the live database: the record is
merged into 107 Amarillo Vista, both of its tablet snapshots moved, `merged`/`merged_into` events and
the audit entry `mortgages.merged` (with the reason) written; no unconfirmed mortgages remain.

## Tests

`tests/integration/data-quality.test.ts` (heading paste, refusal, duplicate decision, merge
guards, card-only loans, alerts), domain tests for the parser and the rules, and the browser spec
`tests/e2e/data-quality.spec.ts` (preview safeguards and a merge through the real step-up dialog).
515 unit and integration tests, 19 browser tests (axe clean).
