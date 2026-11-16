# Commissions (Phase 5)

Owner answers: `docs/research/08`. The scheme starts **Monday 12 Oct 2026** (London).

## What is earned

| Source | Who | Amount |
|---|---|---|
| Loan interest received (broker interest, early-repayment interest, late fees) | The loan's officer | 50% of (amount − tax withheld) |
| Mortgage banker fee (once, at origination) | The officer who arranged it (tablet FINANCE person) | 20% of the fee |
| | Weekly pool | 30% of the fee, equal shares among confirmed staff |
| | Company | 50% (plus pool rounding remainders) |
| Mortgage weekly broker interest | Company | 100% |

Everything is driven by receipts in the bank data, so commission stops when a loan stops
paying. The officer is the loan's/mortgage's officer when the week is closed.

## The week

Monday 00:00 → Sunday 23:59, Europe/London. While a week is open the app shows a live
estimate. After it ends, Management+:

1. **Confirms the pool roster.** The app pre-ticks staff with activity that week
   (sign-ins and actions in the app, loans and mortgages they arranged, bank rows they
   initiated) and shows the evidence; Management ticks/unticks and **locks** it.
2. **Closes the week.** Blocked until the books hold a bank row dated after the week ended
   (an export taken after Sunday, so every receipt in the week is in), and while any earning
   has no officer or any mortgage fee is unknown. Closing freezes the lines and per-person
   totals (whole dollars; each person's total rounded, pool shares rounded down) and posts
   `Dr 5000 Commission expense / Cr 2000 Commissions payable`. It waits for any import or paste
   in progress and calculates inside its own transaction. Closed weeks never change.

**Late arrivals** (review 2026-10-13, owner: "do whatever you recommended"). Interest dated in a
week that was already closed when it was imported or linked to its loan, and banker fees of
mortgages originated in a closed week, are added to the next open week, labelled "· 15 Oct,
arrived after its week closed". Something counts as paid once a closed week has a line for it
(the receipt for interest, the originator line for a fee), so it's paid exactly once whichever
open week closes first. A late fee's pool share goes to the pool of the week that pays it. The
catch-up period has no late arrivals: it covers receipts before the scheme only.

## Catch-up before the scheme (research/10)

Loan-interest commission was last paid by hand on 27 Sep, so a one-off period with key
`catch-up` (`CATCH_UP_KEY`) covers **25 Aug 00:00 → 12 Oct 00:00 London**. It holds
every loan interest receipt in that range that no old payment listed, at the same 50%
net-of-tax rule; no pool and no banker fees (those were paid under the old scheme until
9 Oct). It has no roster, can be closed from 12 Oct, and books and settles like a week.

Old payments are read from bank rows categorised `commission` before the start whose
comment contains "Commission Pay" (`src/domain/commissions/legacy.ts`). An item covers a
receipt with the **same borrower name within a day** (export vs UK date); kind and
amount only break ties, since how much was paid was the payer's call. Each item covers
at most one receipt. Receipts from a week before the period are matched too, so an item
isn't consumed by a neighbouring receipt. The page lists what was left out and why.

**Officer suggestions.** Each old payment's target wallet is the officer who was paid.
Management links a wallet to its person (`linkWallet`, which also sets `staff.wallet_id`
and matches any waiting payouts to it). The app then suggests that person as officer
for loans without one: the wallet that was paid for that loan's own receipts, or failing
that the latest wallet paid for that borrower. Only loans still earning (active,
overdue, defaulted) or with unpaid catch-up receipts are suggested. Management unticks
any that are wrong and assigns the rest (`loans.reassign_officer`, audited per loan).

## Payouts

Staff are paid in-game ("Employee Pay: Commission Pay: …"). After the start date every
such bank row is a payout: it is matched to a person by the target wallet (each staff
member's wallet ID, learned the first time Management assigns a payout), or assigned by
hand. A matched payout posts `Dr 2000 / Cr 5000`, moving it from expense to settling what
is owed (the bank import booked it as expense). A payout for work under the old scheme
can be marked as such and stays an expense.

Balance owed to a person = awards from closed weeks − payouts matched to them.

## Visibility

Officers see their own estimate, awards, payouts and balance. Management+
(`commissions.view_all`) sees everyone; `commissions.manage` locks rosters, closes weeks
and assigns payouts. All actions are audited.

## Pay sheet (research/11)

Commissions → *Pay sheet*: one line per person owed (awards from closed weeks and the
catch-up, less matched payouts), with their State ID, wallet and a comment to paste:
`[COMM] Commission Pay: catch-up, w/c 12 Oct`. Payouts are applied oldest period first
to show which periods are still unpaid. The `[COMM]` tag makes the import classify the
row as commission with certainty; the wallet matches it to the person. Someone paid
more than earned shows as *paid ahead*.

**Paying from the phone (owner, 2026-11-02).** The phone's Litt's Loans card (⋯ menu) pays staff only through
*Pay Employee* — State ID, Amount, Comment, Submit. *Transfer* (State ID or Wallet ID) fails from a business wallet to a
personal one. The import still matches the payout by the wallet it lands in.

**Phone helper** (`src/lib/pay-helper.ts`, `tests/e2e/pay-helper.spec.ts`): *Copy list for the phone* copies the
sheet as JSON (State ID, whole-dollar amount, comment; an id that changes with any row). *Copy phone helper* copies a
bookmarklet for the phone page (game-fivem-ui.onx.gg, a React app with no CSP). On the phone it shows a panel: paste
the list, then per person open Pay Employee and click *Fill next*; it fills the three fields (native value setter +
`input` event) and the person presses Submit. It refuses unless the card's number 69811362 is on screen and refuses
the Transfer form (its "... or Wallet ID" label). Since 2026-11-16 Pay Employee opens with an *Employee* dropdown (every staff member's name and
role) and the box below it is labelled "... or State ID": the helper leaves the dropdown on "Select Employee" and
fills the State ID box, matching labels with any leading "... or" removed. Pressing Submit with the form still holding what was filled ticks
the person (kept in the phone page's localStorage per list id; *Untick* if the phone showed an error); a changed form
isn't ticked. It never presses Submit itself. The function is serialised with `toString()`, so it must stay
self-contained — the unit test rejects bundler helpers such as esbuild's `__name(...)`.

## Rates are settings (research/11)

The three rates are company settings (Settings page, Owner/CEO/COO, fresh 2FA + reason,
versioned). Weeks not yet closed use the current rates; closing stores them on the week.
The catch-up's comparison with old payments always uses the old scheme's 50%.
