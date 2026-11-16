# Origination — making new loans and mortgages (2026-10-10)

Helps loan officers price a new private loan or mortgage within the handbook (§4 A–C),
write the loan contract, and set the deal up in the game with the right figures. Owner
answers: `docs/research/15`.

## Private loans — offers

`/loans/new` → `/loans/offers/[id]` (capability `loans.originate`, loan officer and up).

| Status | Meaning |
|---|---|
| `draft` | Being worked out; can still be edited. |
| `issued` | The contract text is frozen (`loan_offer.contract_text`), ready to copy. |
| `funded` | The game paid it out: matched to its loan by the loan sync. |
| `cancelled` | Borrower walked away / terms changed (reason, audited). |

- **Kinds**: motor vehicle, property (the owner's two templates, word for word) and a
  personal loan (a third template drafted from them: purpose stated, collateral optional).
  `src/domain/origination/contracts.ts`.
- **Figures** (`offerFigures`): flat interest — total = P + whole dollars(P × rate); weekly =
  whole dollars(total / weeks), last takes the remainder; first payment a week after the
  contract date. The game never charges the last instalment's interest (research/14), so
  the borrower usually pays a little less than the contract says.
- **State rate**: always 1% (setting `loans.stateRatePct`), typed into the game by the
  officer. It comes off the principal Litt's gets back, so "Litt's earns" = interest − 1% of
  the principal, before tax and commission.
- **Rate guide** (`suggestRate`): a starting point of 15% moved by the handbook's factors —
  collateral and loan-to-value, size, term, payment as a share of stated weekly income — and
  the borrower's record with Litt's; clamped to 10–25% and shown with its reasons. A
  suggestion only; the officer sets the rate.
- **Checks** (`offerChecks`): warnings only (owner) — rate outside 10–25% needs Executive
  sign-off, State rate not 1%, State rate ≥ rate, LTV over 100%, weekly payment over 40% of
  income, missing Defaulted Account Fee — plus the borrower lending check (do-not-lend,
  defaults, open loans).
- **Defaulted Account Fee**: the officer chooses; suggested at 0.75% of the loan a day to
  the nearest $50.
- **Contract date** can't be in the past: contracts are only written for new loans.
- **Matching** (`syncLoans` step 6): an issued offer becomes `funded` when a loan to the same
  borrower for the same principal is opened from the day before the contract date to 21
  days after; each loan takes one offer. The offer page then compares the phone card with
  the contract (`contractDifferences`: amount, rate, State rate, payments) and the loan page
  links back to the contract.

## Mortgages — quotes

`/mortgages/quotes/new` → `/mortgages/quotes/[id]`. No contract: the tablet's Sale
Agreement is the contract. A quote is the terms worked out with the buyer and a tablet
checklist (each figure copyable).

| Status | Meaning |
|---|---|
| `draft` | Terms being worked out; editable. Shown as a what-if on the outlook, never drawn from the allowance. |
| `confirmed` | The buyer is going ahead; has an expected signing time (when the bidding closes). Draws on the projected allowance. Optionally marked "Signed in game" before the tablet is pasted. |
| `matched` | The tablet agreement was pasted and matched to it ("Became a mortgage"). |
| `cancelled` | Dropped (reason, audited). |

Changing the money or identity terms of a confirmed quote sends it back to draft (`confirmation: "cleared"` in the
audit); changing only the signing time, notes or buyer's name keeps it confirmed. Design: `docs/research/19`.

- `quoteMortgage` reproduces the tablet to the dollar (all 27 agreements on record): base =
  price − agency commission; down payment, banker fee, broker and federal interest and the
  5% tax are rounded **up**; weekly payments = ⌈months × 52 / 12⌉, each part rounded down,
  the last taking the remainder; at signing the buyer pays down payment + banker fee +
  agency commission + tax.
- Defaults: down payment 10%, fed rate 3%, broker rate 6% (handbook: start at 6%), banker
  fee empty = the band's federal maximum. **Federal maximums** (research/17): a State-funded
  quote over its band's maximum banker fee or broker rate can't be saved, by anyone
  (`federalMaximumBreaches`, checked in `saveQuote`). A quote can be marked company-funded:
  no fed rate, no maximums, not counted against the State allowance. Other checks
  (`quoteChecks`, flags only): fed rate below 3% (primary residence) or 10% (any other
  property), down payment under 10%.
- The originator's share of the banker fee (settings) is shown as "Your share".
- **Matching** (`matchQuotes`, end of `syncMortgages`): a draft or confirmed quote becomes `matched` to a
  mortgage with the same buyer and the same loan amount or address (aliases included),
  originated from the day before the quote to 30 days after. The quote page then compares
  the agreement with the quote (`quoteDifferences`).
- **Review notes** (research/18): management write what needs changing on a colleague's open quote instead of changing
  it; the officer marks each note done (optional reply). Append-only `mortgage_quote_note`.
- **Executive approval** (research/18): a quote over the settings line ($1,000,000 down payment + loan) waits for an
  executive (Owner/CEO/COO) before it goes on the tablet — no copy buttons until approved. An executive's own save
  approves it; changing the approved terms clears it.

## Data

Migration 0019: `loan_offer`, `mortgage_quote` (numbered, audited:
`loans.offer.created|updated|issued|cancelled`, `mortgages.quote.created|updated|cancelled`).

**Team visibility (owner, 2026-10-11):** everyone with `loans.originate` sees every offer and
quote (lists default to *Everyone*, with a *Mine* switch) so officers can help each other;
only the officer who made it, or `loans.reassign_officer` (management), can edit, issue or
cancel (`canActOnOffer` / `canActOnQuote`). A colleague's offer or quote opens read-only.
Running loans and mortgages keep their usual visibility — links from an offer/quote to its
loan/mortgage show only to people who can see it.

**Correcting a match (2026-10-11):** the automatic pairing (offer → loan, quote → mortgage)
can be wrong — e.g. two loans of the same size to one borrower. The offer's/quote's officer or
management can **unlink** it ("Not this loan/mortgage", with a reason): it goes back to
issued/open and that loan/mortgage is remembered in `excluded_loan_ids` /
`excluded_mortgage_ids` (migration 0021) so the sync never pairs them again. They can then
**link** the right one by hand from the borrower's/buyer's own loans or mortgages (not one
another offer/quote holds). Both are audited (`loans.offer.unlinked|linked`,
`mortgages.quote.unlinked|linked`).

**Card terms on a paid-out offer:** colleagues who can see the offer also see the comparison
of the contract with the phone card (e.g. the rates), even if they can't open the loan
itself — owner, 2026-10-11: "It's fine if colleagues can see that."

**Allowance outlook** (research/19): the Quotes page charts the State allowance over the next 14 days
(`domain/mortgages/allowance-outlook.ts`). It starts from the latest reading, counts each repayment once from
`max(reading, end of the bank data)`, subtracts every confirmed quote's loan at its signing time, and shows drafts as
what-ifs. The quote table has "Signing (bids close)" and "Allowance at signing" with Fits/Tight/Short badges. The
Confirm dialog works out the allowance just before signing on the server as the time changes; the quote form works it
out in the browser from the outlook line (`allowanceLine`, 60 days ahead) as you type. A
shortfall warns, never blocks. Moving a confirmed quote's signing time earlier in the edit form raises no "pushed
short" notification and shows no knock-on; only confirming does. Times on the chart are the viewer's own (UK time until the page has loaded). Officers see figures only, never other people's
mortgages; readings and rules stay on the Finance page. Settings: `loans.rateMinPct`, `rateMaxPct`, `stateRatePct`,
`maxPaymentToIncomePct`, `defaultFeePerDayPct`, the contract's day/hour terms;
`mortgages.brokerRateStartPct`, `downPaymentMinPct`, banker fee range.
