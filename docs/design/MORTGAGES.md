# Mortgages and the State allowance (Phase 4)

Owner answers: `docs/research/07`. Money flows were already booked in Phase 2
(`docs/design/LEDGER.md` §mortgage pass-through); this phase adds the servicing view.

## Two sources, one mortgage

| Source | Gives |
|---|---|
| **Bank rows** | `<addr>: Down Payment & Fees` (in, buyer is the initiator) at origination; `<addr>: Loan Repayment` (in) weekly, `<addr>: Final Loan Repayment` for the last one; matching outs to the State |
| **Tablet paste** (Sale Agreement – Financed → details) | Price, down payment, loan amount, broker/federal interest, term, rates, fees, parties (agency + agent, finance officer, buyer) |

Identity: the origination's **in-leg bank row** (`Down Payment & Fees`). A property can
be sold again later, so the address alone is not unique. Repayments link by **who paid**
(research/20, `repaymentMortgage`): the payer's mortgage on that address (the most recent
started at or before the payment), else the payer's only open mortgage, else the one whose
repayments were the same amount, else none. A payer with no mortgage on record falls back
to the address alone.

**Renumbered addresses.** The server sometimes changes a house's address, so the down
payment, the tablet and later repayments can disagree. The money is the reliable link:
the down payment nets exactly down payment + banker fee + agency commission, and the
transfer to the State is down payment + agency commission (`originationFits`). A tablet
paste with no address match is matched to the same buyer's unpasted mortgage whose
money fits exactly; the mortgage takes the tablet's address and keeps the old one in
`address_aliases`. A buyer's repayment under a new address does the same (the newest
evidence wins; event `address_changed`). The server also hands old numbers to other
houses, so an address match never counts against another known buyer. Duplicates created before this rule
are merged by the sync when they match one-to-one: the pasted record keeps its history
and takes the origination and repayments; the other is kept, marked `merged_into_id`,
and hidden everywhere.

Mortgages are created by `syncMortgages` from every origination row (idempotent, runs
after each bank import, tablet paste and reclassification — never on page load since
2026-10-11; `mortgageSyncPending()` checks nothing is left behind). A tablet paste fills in terms and parties. A
paste with no matching origination creates a tablet-only mortgage that adopts its
origination when it is imported (as for loans).

## Malformed pastes and duplicates (2026-10-12, docs/qa/DATA-QUALITY-2026-10-12.md)

- The address is the first header line starting with a house number; the tablet's heading and tabs
  copied above it are skipped (and listed in the preview). A paste with no address never matches by address.
- A **new** record needs address, buyer State ID, down payment + loan ("Loan details" open) and a
  payment count — otherwise the item is refused. Updates may be partial.
- A would-be new agreement whose buyer has a mortgage at the same price/loan (or one not pasted yet)
  is a *possible duplicate*: staff choose update / add as new / skip.
- Management+ can merge a duplicate with no bank money into the real record (step-up + reason):
  pastes and quote move, `merged_into_id` hides it, old links redirect. One with a collections log is
  refused (the log is append-only).
- A tablet-only mortgage the bank data has moved more than a day past is flagged (dashboard, bell, health check).

## Company-funded mortgages

For small mortgages the company may lend its own money instead of the State's (owner,
research/07). Recognised from the tablet (no Fed rate / Federal Interest) and confirmed
by the money (`originationPattern`): the buyer pays down payment + banker fee, and Litt's
pays the State down payment + loan.

Accounting: the bank pairing books the origination residual (banker fee − loan) to 4100;
the sync then posts `Dr 1120 Mortgages receivable — company-funded / Cr 4100` for the
loan, leaving 4100 = banker fee (`mortgage.funding_entry_id`). Repayments have no
transfer to the State: each is posted `Dr 1110 / Cr 1120 principal / Cr 4110 interest`
by the schedule (`mortgage_payment.entry_id`). They don't use the State's money, so
they're excluded from the allowance comparison. KPIs show money owed to Litt's
separately from money owed to the State.

## Schedule

`N` = weekly payments. Instalment *k* is due `origination + 7k days`; each is
`loan/N` principal + `interest/N` broker interest + `federal/N` federal interest, whole
dollars, the last instalment taking the remainders. The bank's gross repayment includes
the federal interest, withheld as tax; Litt's keeps the broker interest.

Payment state is derived from the schedule and the linked repayments (no stored
status apart from `completed`): **on track**, **late** (past due, within the grace
period), **behind** (past grace), **completed** (all N paid). Contract vs actual per
instalment is shown; a repayment that differs from the schedule by more than $1 is flagged.

## Guidelines (research/04, 17)

**Federal maximums** (owner, 2026-10-15; research/17): State-funded mortgages arranged from 15 Oct 2026 have a maximum
banker fee and broker rate set by the band their **down payment + loan** falls in (whole mortgage at its band; settings).
Over them = breach flag and an executive notification — the agreement is still recorded, since the game can't be
stopped; quotes over them can't be saved. They replaced the old ranges (7.5% State broker maximum, 3–7% company range,
banker fee 7.5–15%). Fed rate < 3% = breach; fed < 10% when the buyer already holds another Litt's mortgage = warning
(possible non-primary). LTV is shown on every mortgage.

**Executive approval** (owner, 2026-10-15; research/18): a mortgage arranged from 15 Oct 2026 whose down payment + loan is
over the settings line ($1,000,000), State- or company-funded, needs an executive's approval: its officer is an
executive, or its quote was approved before signing and the agreement matches it, or an executive approved it after the
fact (reason, `executive_approved` event). Otherwise a breach flag and an executive notification.

## State allowance

The allowance is the State's credit limit for Litt's mortgages. It isn't money in the
business wallet, so it is tracked outside the ledger.

- **Readings**: Management+ records the balance seen on the phone, with the time seen.
  Readings are append-only; a wrong one is voided with a reason.
- **Events** the app knows about: mortgage originations (loan amount), repayments
  (gross weekly payment and principal), legacy sanctions parsed from phone cards.
- **Rule fitting**: for each pair of consecutive readings, the observed change is
  compared with what each candidate rule predicts:
  origination −1× loan; repayment +4× payment *or* +4× principal *or* +1× principal.
  The rule with the smallest total error is suggested; Management+ adopts a rule, which
  then drives "expected balance now" = last reading + predicted movements since.
- **Observed rule** (production readings, 9–19 Oct 2026; `docs/research/19`): −1× the loan when a mortgage starts,
  +4× the principal of each repayment (`o1-principal4`). It matches 13 of 16 informative intervals to the dollar. The
  misses: a one-off **$1,300,000** top-up from the State (the reading noted "Jerry Money"; top-ups appear only through
  readings), and a repayment credited a few minutes after the reading that should have included it (the game lags).
  **The owner adopted `o1-principal4` on 2026-10-19.** The quote outlook projects from it.
- A defaulted tablet mortgage is expected to be **sanctioned** against the allowance
  (owner); the multiple is learned from the first case.

## Late fee

Unknown recipient (owner). Rows that look like a late fee are flagged for checking
rather than auto-classified.

## Visibility

As loans: officers see their own mortgages (officer = the tablet's FINANCE person,
matched to staff by State ID); Legal+ see all. The allowance page is Management+
(`finance.view`).
