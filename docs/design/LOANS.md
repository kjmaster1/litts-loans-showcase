# Loans module design (Phase 3)

## Two sources, one loan

| Source | Gives | Weakness |
|---|---|---|
| **Bank rows** (already imported) | Who borrowed, how much, when (`Loan Transfer`); every payment with its money split | No terms, no status, no officer |
| **Phone cards** (weekly paste of 4 tabs) | Terms (instalments, broker %, state %, frequency), progress k/N, missed payments, status | No dates, no officer; Overdue/Default cards omit the principal |

The app joins them. A loan's identity is its **disbursement** (the `Loan Transfer`
bank row); cards are matched onto it.

### Linking bank rows to loans (pure, `src/domain/loans/link.ts`)

Payment comments identify the loan more often than not:

- `Subscription payment Loan Agreement Amount: $Pk/N` → principal **P**, instalment k of N.
  The digits are concatenated ("$6000012/12" could be 60000 + 12/12 or 600001 + 2/12),
  so every split is tried and the one matching a known disbursement wins.
- `Broker percentage payment: Loan Agreement Amount: $P ID: <24-hex>` → P and the
  agreement **ID**. OVERDUE/DEFAULTED variants carry only the ID, resolved via the
  ID→loan map learned from the other rows.
- `Early/Late Finance Repayment…` carry neither → the borrower's loan that was open
  at that moment (oldest first). Marked *inferred*.
- `Broker Fee: Paid Broker Fee` ($1) → the disbursement in the same few seconds.

### Matching cards to loans

Card → borrower State ID, then:
1. Active/Complete cards show `Loan Agreement Amount: $P` → the borrower's loan with principal P
   (if several, the one whose payment count best matches k/N).
2. Overdue/Default cards have no P → the borrower's loans whose instalment count N and
   broker rate fit; one candidate → matched, several → **the user picks** in the preview.
3. Legacy mortgage cards (wallet 69794349, `TYPE mortgage`) are reported and ignored
   (no active legacy mortgages — research/02).
4. A card with no matching disbursement creates a loan from the card alone (*unlinked*).

## Status

`active → overdue → defaulted → written_off`, or `completed`. The status is simply
the phone tab the card was last pasted from (the game is the source of truth): a card
in the Active tab showing a missed payment is still **active** (its missed count is
shown). The exception is **written off**, an accounting decision. A loan absent from
a weekly paste of the tab it was in is flagged.

## Accounting additions

New accounts: **5100 State loan levy**, **5300 Credit losses**, **4310 Loan closing
surplus**, **5110 Loan closing shortfall**.

- **State levy** — the State keeps `s` of each principal instalment (borrower pays
  `P/N·(1+b)`; the company receives `P/N·(1−s)` + interest). For each linked principal
  receipt the shortfall is booked `Dr 5100 / Cr 1100` so a fully repaid loan's
  receivable reaches zero. Early repayments carry **no** levy (owner, 2026-10-13): the game takes only the
  `X(1 − b − s)` credited to Litt's off the loan, so the State's `Xs` is on top, paid by the borrower. (Until then the
  app booked `Xs` as levy; Onyx Greystone's open loan showed −$156 where her card said $156 left, and completed loans
  carried an equal closing surplus. The sync's levy true-up reverses both; on a written-off loan the
  correction goes to 5300 credit losses, since the write-off was sized from the old levy.)
- **Write-off** — `Dr 5300 / Cr 1100` for the outstanding principal (sensitive action:
  fresh 2FA + reason). Principal received afterwards is reclassified
  `Dr 1100 / Cr 4300 Recoveries`.
- **Whole dollars** — the game never moves cents, so the levy (per receipt), the
  contract schedule and adjustments are rounded to whole dollars (`wholeDollars`).
  The sync trues up levies posted under an earlier rule with correction entries
  (`Dr 5100 / Cr 1100` or the reverse) and keeps `loan_payment_link.levy_cents` equal
  to what's booked.
- **Closing adjustment** — when the game marks a loan complete, whatever is left on its
  receivable is cleared (`loan_adjustment`, append-only): a shortfall `Dr 5110 / Cr 1100`,
  a surplus `Dr 1100 / Cr 4310`. Causes: whole-dollar rounding, the game's
  early-repayment bugs (overcharging → surplus), and early/late rows attributed to the
  wrong one of a borrower's overlapping loans (the rows carry no identifier; the
  borrower's totals are right). Each loan's net closing difference is kept wholly in
  one account (later corrections move it between 4310 and 5110 rather than split it).
  On the fixture: 53 completed loans, surplus $59.8k,
  shortfall $23.7k. Later receipts on a completed loan add another adjustment.
- All loan accounting is posted by an idempotent *sync* that runs after every bank
  import and card paste; each posting is linked so it's never duplicated.

## Contract vs actual (game bug flags — research/02)

- **Contract schedule**: N instalments every `period` days from the disbursement;
  each `P/N` principal + `P/N·b` interest.
- **Instalments paid** (`instalmentsPaid`, QA 2026-10-13): regular *and* late principal rows — a "Late Finance
  Repayment" pays the missed instalment, and the phone's "n/N complete" counts it (8 live loans checked). Early
  repayments don't count (the game keeps N and shrinks the instalments).
- **The game's due dates** (`gameDueDates`, QA 2026-10-13): the game doesn't keep the contract's dates. Each
  instalment falls due one period after the previous one was *paid* (on time or late); the game charges a few
  minutes after that, so dates drift ~30 minutes a week, and a late payment moves every later date on by days
  (Ridley Thornbury: 9th due 19 Oct by the phone, 17 Oct by the contract). The loan page's "Not paid"/"Next" markers
  and Portfolio health's *behind* use these dates; the schedule's Due column stays the contract's.
- **Next payment** (`nextPaymentDue`, loan sync step 4d): for a running loan with a bank start, the game's due date of
  the next instalment, from the bank. The card's "Next payment: in N hours/days" counts from when the text was
  *copied*, so it is only an estimate (and late when an old copy is pasted: 13 Oct 2026, 1 h 45 m); it is used only
  while the bank is behind the phone, or for a loan known only from cards. The paste preview warns about a tab pasted
  again with the same text once its countdowns should have moved (`staleRepaste`).
- **Early-repayment overcharge (Bug A)**: interest charged on early principal above
  `principal × b`.
- **Interest without principal (Bug C)**: an early-interest row with no principal row
  within ±2 s.
- **Overdue penalty** (audit F5; owner 2026-10-13: a late fee): after a missed payment the game adds 2% per missed
  payment, compounding, to both parts of every later instalment. The principal part's extra (`penaltyFor`: the
  contract receipt × 1.02^k, found from the money) is stored on the link (`penalty_cents`) and booked by the loan sync
  Dr 1100 / Cr 4000 (Dr 5300 on a written-off loan) — principal received, the levy and the closing residual all leave
  it out. The interest part's extra is interest income anyway. The phone's "remaining" adds the penalty on what's
  still to pay.

## Visibility

Officers see their own loans in full and can look up any borrower's history summary
(spec §2). Legal and above see all loans.

## Weekly paste (implemented)

`src/server/loans/paste.ts`. Preview is stateless (nothing stored); commit re-parses and
re-matches the same text and applies the user's choices, so the browser can only pick
among loans the matcher offered.

- Ambiguous cards must be resolved (choose a loan or skip). A new card (no loan in the bank
  data) needs an explicit "Add as a new loan" or "Skip", and only a card that states its amount
  can start a card-only loan (no estimates — 2026-10-12). When its disbursement is later imported
  the sync adopts it instead of duplicating. The same card twice in one paste counts once.
- Card-only loans that shouldn't exist are **retired** by Management+ (step-up + reason): merged
  into the same borrower's loan (cards, collateral, offer move) or retired as a mistake.
  `loan.retired_at` / `merged_into_id` (migration 0022); every loan query uses `liveLoan`; the DB
  allows it only without a disbursement. Flagged when the bank data has moved a day past it.
- Officers: a paste only fills in a missing officer. Loan officers may assign only
  themselves; Management+ anyone. Changing an officer is done on the loan page (reason
  required).
- Status per `statusFromCard` (`src/domain/loans/status.ts`); `firstDefaultAt` is
  estimated as first missed payment + 2 periods; `completedAt` = last linked payment.
- Loans last seen in the pasted tab but absent now are listed (informational).
- Each paste is kept (`loan_paste`, `loan_card` with the raw text) as status history.

## Write-off (implemented)

Management+, fresh step-up, reason ≥ 5 chars, status `defaulted`, at least 28 days after
`firstDefaultAt`, and something outstanding. Posts `Dr 5300 / Cr 1100`; status becomes
`written_off` permanently; later principal receipts post as recoveries (4300).

## Linking improvements and corrections (2026-10-10)

Owner report: a borrower with two loans at once (Dakota Thornbury) had payments on the wrong
loan and the two loans' terms swapped. Cause: early-version comments state the **total
repayable** (principal × (1 + broker rate)) rather than the principal, so nothing
identified the loan and the "oldest open loan" guess was used; the cards were then
matched by instalment counts taken from those wrong links.

The linker (`src/domain/loans/link.ts`) now identifies a payment, in order, by:
agreement amount (principal **or** total repayable at a plausible rate), agreement ID,
the "k/N" instalment count (when only one of the borrower's loans has N payments),
pairing with an identified row paid in the same second, and only then the oldest-open
guess. On the fixture the guesses fell from ~400 to 213. The card matcher also treats a
loan whose comments reached "N/N" as finished.

Stored links are never moved automatically. `src/server/loans/relink.ts` compares the
current matcher with the stored links; the Loans list lists affected borrowers and the
loan page shows the proposed moves. Applying (Management+, reason, audited) moves the
links, re-matches the borrower's latest phone cards (terms and status follow the right
card) and lets the sync true-up the State levy and closing adjustments. Payments of a
written-off loan are never moved.

## Default dates (2026-10-10)

Write-off becomes available 28 days after `first_default_at`. It's estimated from the
card's "First missed payment" date + 2 periods; old-version cards have no such date, so
it is the last principal payment (or the loan's start) + 3 periods (weekly unless known).
Earlier, those loans fell back to the day the card was first pasted, which pushed
write-off weeks too late (owner report: Arlo Oswin, opened 14 Feb, never paid →
defaulted ~7 Mar, not 9 Oct). The sync corrects such dates (only ever earlier, noted in
the loan's history as "Default date corrected").

## Repaid but stuck in the game (2026-10-10)

Game bug (owner report: Onyx Sutcliffe): a loan paid off early stays in the Default tab —
the game keeps charging tiny "payments" after payoff, then counts misses. Management+ can
**mark it repaid** when the books agree (no more than $100 still owed; more is a real loss
? write off). It becomes completed at the last real principal payment and is
**status-locked**: later pastes and corrections leave its status alone. Reason + audit.

## Can we lend? (research/11)

Borrower lookup → *Can we lend?* for any State ID (first-timers included), with the
amount and rate being asked for. Flags (`src/domain/loans/lending.ts`): a *do not lend*
mark (Management+, reason, audited, cleared not deleted — `borrower_flag`), loans in
default now, write-offs, defaulted-but-repaid, overdue now, mortgages behind, loans
already running (with how loans made alongside another one have gone), and the
company's own record for the size and rate bands (warning at ≥ 20% gone bad, only with
≥ 5 finished loans in the band). Information only — never an approval step (ADR 0001).
Exposure is computed across all loans even for officers; loan details stay per viewer.

## Collections (research/11)

`loan_collection_action` (append-only): spoke to them / no answer / promised to pay
(amount + date) / handed to Legal / seizure / note, with an optional follow-up date (a
promise follows up on its date). The loan's officer, Legal and Management+ can log.
*Collections* (Portfolio) lists overdue and defaulted loans the viewer may see, plus
written-off loans with an active recovery; a loan is *due* when nothing's been logged
or its follow-up date has come. The dashboard shows how many are due.

### Round 12 (research/12)

- **Mortgages too**: a late (in grace) or behind mortgage is a case; the log row carries
  `mortgage_id` instead of `loan_id` (check constraint: exactly one). The mortgage's
  officer, Legal and Management+ can log; once a case has entries it stays open to notes.
- **Promises are checked against the bank** (`promiseOutcome`): *kept* once the borrower
  has paid at least the promised amount (any part — principal, interest, fees; gross)
  between logging it and the end of the promised day; *broken* once that day has passed
  without it; *pending* until then. A broken promise makes the case due and tops the bell.
- **Priority** (`collectionPriority`): log10 of what's owed × (1 + 0.5 × missed, capped at
  6) × (1 + broken promises) × 1.5 if never contacted or a follow-up is due × 0.4 while a
  promise is pending; late mortgages in grace × 0.5. Due cases first, then priority.
- Missed: the card's count (an Overdue card shows at least 1; Defaulted at least 3); a
  mortgage's overdue instalments.

## Game quirks (research/14)

Recorded, never corrected, and marked on the loan page with a **Game quirk** badge: the
final instalment's interest is never charged; early-repayment overcharges and interest with
no principal; overpayment; closing adjustments. A loan whose State rate is above its broker
rate is a *setup* problem (flagged separately — "Check this loan's rates"). Payments without
an identifier that arrive in the same second are one payment and go to the oldest open loan
with enough principal left to take them.

## Profit per loan (research/12)

"Net to Litt's" = income − expenses on every journal entry tied to the loan: entries on its
linked bank rows (interest and fees, tax withheld, levy, levy corrections, recoveries), its
closing adjustments and its write-off, plus reversals of any of those. Before commission
(paid weekly, not per loan). Mortgages likewise: origination and repayment rows, their
State legs and settlement entries. `server/profit.ts`. Finance viewers only.

## Portfolio health and expected losses (research/12)

History is rebuilt from the contract and the bank (`domain/health.ts`), not the phone:
at a moment a loan is *paying*, *behind* (an instalment > 1 day past the game's due date,
counting principal + levy credited ÷ P/N), *defaulted* (from `first_default_at`), *repaid*
or *written off*. The Portfolio health report shows at-risk share now and for 12 weeks,
week-to-week movement, collected vs due (instalments falling due on running loans, P/N ×
(1 + b)), and months lent (vintages).

Expected losses (`domain/risk.ts`) — a figure only, never booked: loss rate by where a
loan is now — *paying*: share of finished loans that went bad; *overdue/behind*: same among
loans ever behind (cards or schedule); *defaulted*: share of ever-defaulted loans that never
came back — times the share of a bad debt never recovered (what bad loans owed at default
less principal paid since). Fewer than 5 cases → the bucket borrows the rate above.
Company-funded mortgages count (late/behind → overdue rate). Realistic book value = owed
− expected losses (dashboard and report).

## Legal cases (2026-11-10, research/21)

Every defaulted or written-off loan has a case (`src/server/legal/cases.ts`; state derived: Needs details → Ready →
With Legal → Closed). The sheet (`domain/legal/case-sheet.ts`) is the latest card's instalment (with the game's +2%
penalties) × instalments left, plus the contract's Defaulted Account Fee per day × London calendar days from the default
to the hand-over, less recoveries in between, plus the collateral. Default date: `first_default_at`, except a loan moved
to Default by hand (card shows < 3 missed) — the second missed payment (first missed + one period); a date set by hand
wins. Fee per day and *unsecured* are on `loan` (officer-entered) or come from the funded offer; collateral from
`loan_collateral` or the offer. Hand-overs (`legal_case_handover`) and the fee-link history (`legal_fee_link`) are append-only.
