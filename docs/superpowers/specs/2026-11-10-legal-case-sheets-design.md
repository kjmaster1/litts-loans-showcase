# Legal case sheets — design (2026-11-10)

Status: **draft for the owner's approval**. Owner: Kieran Jones (CEO).

## Why

When a private loan defaults, the owner writes a short case summary by hand and sends it to the company's
lawyer, who files it with the court as-is. Two things hurt:

1. **The arithmetic is done by hand.** Both examples the owner shared had a slip in the last line
   (`40,235 + 600` for `+ 3,200`, `32,478 + 200` for `+ 1,500`); the totals happened to be right.
2. **The owner relays everything.** The fee per day and the collateral are only in the signed in-game contract,
   which only the issuing loan officer has. Today it goes officer → Kieran → lawyer, one loan at a time,
   including the signed contract the lawyer sometimes asks for.

Success: a defaulted loan's case sheet is produced by the app in the owner's exact format, the officer fills in
what only they know without the owner chasing them, and the lawyer reads the sheet from their own login.

This narrows the SPEC's "legal case management — out of scope (MDW in-game)": the app **prepares and hands over**
the claim; the court case itself stays in the game.

## The sheet (owner's format, verified against production)

```
Rowan Redgrave - 6661

$8,047 * 5 = 40,235

$200 per day in default

Defaulted - July 21st 2026

200 * 16 = $3,200

40,235 + 3,200 = $43,435

Collateral - Ocelot Jackal - G1YBEU4B
```

| Line | Source | Verified |
|---|---|---|
| Name - State ID | the loan's borrower (current name, State ID) | — |
| `$instalment * left` | the **latest phone card's amount** (includes the game's +2% per missed payment) × (instalments − completed on the card) | $8,047 × 5 and $10,826 × 3 match prod exactly |
| per day | the loan's Defaulted Account Fee per day (new, see below) | not in the app for any current loan |
| Defaulted | `loan.first_default_at`, London date, ordinal day ("July 21st 2026") | 21 Jul / 22 Jul match prod |
| `fee * days` | whole days from the default date to the hand-over date (London calendar days) | 16 and 15 = to 6 Aug, the day the owner sent them |
| total | claim + fee total | — |
| Collateral | the loan's collateral description(s); "None (unsecured)" when ticked unsecured | — |

Number formatting follows the examples: `$` on the instalment, the fee line and the final total; thousands
separators everywhere. Exact punctuation is the builder's to match from the two examples (they are slightly
inconsistent — e.g. `$3,200` vs `$1500`; use the comma form throughout).

### Default date rules (owner, 2026-11-10)
- Defaulted by the game (3 missed payments): the third missed payment — what `first_default_at` already holds.
- **Moved to Default by hand** (the card still shows fewer than 3 missed): the **second missed payment**, when the
  game's manual-default button appears. Example: Zion Merriweather (13325), first missed 29 Sep → **6 Oct 2026**.
  `first_default_at` is the paste time for these (9 Oct for Zion), so the case date must be derived: first missed
  payment (on the card) + one period. The sheet should say which rule it used, and staff can correct the date
  before hand-over (audited) for anything odd.

## Workflow

1. **A loan defaults** (status `defaulted` or `written_off` — written-off loans are still pursued; Rowan Redgrave
   and Hollis Vance were both written off). It appears on a new **Legal cases** page (sidebar, under Loans) as
   *Needs details* or *Ready*.
2. **Details**: two pieces only the officer has — **fee per day** and **collateral** (or an explicit
   *Unsecured* tick). Loans created from an in-app offer take both from the offer automatically. For older loans,
   anyone who can see the case presses **Ask the officer**: the officer's bell shows "Legal needs the contract
   details for <name>" until both are filled in. **Officers type them in themselves** (owner) on the loan page;
   no approval step. Every change is audited.
3. **Contract shared**: the request also asks the officer to share the signed contract with the lawyer in game;
   the officer ticks **Contract shared with Legal**. Informational — doesn't block anything.
4. **Hand to Legal** — allowed for **the owner/executives, management, and the loan's own officer** (owner).
   Requires fee per day and collateral/unsecured to be set. It:
   - counts the days in default **up to that day** (owner) and **freezes the whole sheet** — a permanent,
     append-only record of exactly what the lawyer got;
   - writes the existing `handed_to_legal` collections entry;
   - moves the case to *With Legal*.
   Before hand-over the page shows a live preview counted to today.
5. **The lawyer** (an outside person, given a Legal Team login — owner is fine with them seeing everything that
   role sees) opens Legal cases, copies the frozen sheet (one click), and sees the officer's name to ask for the
   contract directly.

## Attorney & filing fee (owner, 2026-11-10)

Each case handed over costs an **attorney & filing fee paid to the lawyer** from the business wallet: **$2,750 per
case** with the current lawyer, paid on the day of hand-over (sometimes later). From the bank export
(`reference/samples`, 2026-02 → 2026-06): every such payment is `pay` 69811362 → the lawyer's wallet, $2,750,
comment `Employee Pay: Attorney & Filing Fee - <Borrower> Default` (older ones name no borrower, so can't be linked).
Already classified `legal` → 5400 (`classify.ts` rule "legal") but not linked to any loan.

- The fee is a **setting** (default $2,750), since it's per lawyer — never hard-coded.
- The payee is a Legal Team staff member (their State ID); the hand-over picks one, defaulting to the only one.
- After hand-over the case shows **Fee to pay: $2,750** with a generated comment carrying a case reference, e.g.
  `Attorney & Filing Fee - Rowan Redgrave Default #LC12`, and a **phone helper** button reusing the commission pay
  helper (`lib/pay-helper.ts`): it fills ⋯ → Pay Employee; the person presses Submit. Nothing is sent by the app.
- On the next bank import the matching `pay` row (by the case reference in the comment; fall back to borrower
  name + amount + payee for a hand-typed comment, as a reviewable suggestion) is **linked to the case**: fee shown
  as paid, the cost visible on the loan. Classification stays `legal` / 5400.
- A case handed over with its fee unpaid for more than a day shows in the bell for whoever handed it over and
  executives, until the bank shows it paid.
- Non-goal: linking the historic unreferenced fee payments; adding the fee to the borrower's claim (the owner's
  format doesn't).

## Money recovered (owner, 2026-11-10)

Money usually comes back *after* the case: from selling the collateral, occasionally a manual payment, or the court
seizing the borrower's bank balance and transferring it to Litt's. These are already filed as recoveries
(`recovery.settlement`, `recovery.seizure`, `collateral_sale` — `domain/loans/recovery.ts`).

- *Builder's call (Claude):* recoveries linked to the loan **before** hand-over are subtracted on the sheet as one
  extra line (`- $X received since default`), shown only when non-zero; phone-paid instalments already reduce
  "left" via the card, so they are not subtracted twice.
- After hand-over the frozen sheet never changes; the case page shows **recovered since hand-over** next to the
  claim (informational), so the lawyer and owner can see what's still owed.
- Owner (2026-11-10): the judge *sometimes* awards the attorney & filing fee to Litt's as part of the civil case, so
  the fee is not on the sheet. Most defaulters have left the city, so in practice the only money back is from
  **selling the collateral**, which usually covers the debt only partly. So the case page's money picture is:
  **Claim · Fee paid · Recovered (collateral sale, seizure, payments) · Net for Litt's** (recovered − fee) and
  **Still owed** (claim − recovered, floored at zero). No record of the judgment itself.
- *Claude's call:* a case can be **Closed** by management/executives with a short note (e.g. "collateral sold,
  rest unrecoverable") to take it off the open list; recoveries that arrive later still show on it.

## Goals / non-goals / anti-goals

Goals: the sheet in the owner's format with correct arithmetic; the officer request without the owner in the
middle; a frozen record of what was handed over; the lawyer self-serves.

Non-goals: tracking the court case (hearings, verdicts — MDW in-game); mortgages (none have defaulted; out of
scope for now); sending anything outside the app (no Discord/email); storing or uploading the signed contract.

Anti-goals (would be a failure even if it works): a sheet going out with a blank fee or collateral; a sheet whose
figures silently change after it was handed over; recognising a loan by borrower (a State ID can hold several
loans — Hollis Vance has a completed one and a defaulted one); the lawyer showing up as a possible loan officer
or in the commission pool suggestions.

## Constraints (from CLAUDE.md)

Record-level rules only in `src/server/authz/rules.ts` (a new `canHandToLegal`, = executive/management or own
officer); every mutation audited in the same transaction with a label in `audit-labels.ts`; the frozen sheet table
is append-only with `REVOKE UPDATE, DELETE ... FROM litts_app`; every loan query includes `liveLoan`; new sidebar
place needs a `describe()` line in the tour; notifications are derived from data (`notifications.ts`), only "read"
is stored; e2e spec for the new page; text via `lib/format.ts`; whole dollars.

## Left to the builder

Table/column shapes (e.g. fee per day and *unsecured* on `loan` vs a small `loan_legal_terms` table; how the
officer request is stored so the bell can derive it); whether a mistaken hand-over is undone by a superseding
hand-over (management, with a reason) — never by editing the frozen row; page layout within the design system.

## Immediate need (the eight State IDs)

25718, 15819, 4457, 14962, 13325, 2932, 9115, 20511. All eight are missing the fee per day and collateral, so
the officers must supply them: Zion Pemberton (25718, 14962), Cove Berry (15819, 4457, 2932, 9115), Skyler Marlowe
(13325, 20511). **The owner will wait for the feature** (2026-11-10): once deployed, they ask the officers through it.
Tatum Bramley (20511) has defaulted in game but the Default cards haven't been pasted yet — the paste brings it in.

## Calls made by Claude (for the owner to check)

1. **Ask the officer** is an explicit request rather than every defaulted loan nagging its officer — many old
   defaulted/written-off loans may never go to court.
2. Anyone who can already record collateral on the loan (its officer, Legal and above) can fill in the fee per day;
   so if the officer has left, management or the lawyer can enter it.
3. Mortgages are out of scope.
4. Recoveries before hand-over are subtracted as an extra line; after hand-over they're shown, never changing the
   frozen sheet.
5. A mistaken hand-over is fixed by a newer hand-over (management, with a reason), never by editing the old one.
6. Case statuses are *Needs details → Ready → With Legal → Closed* (closing: management/executives, with a note);
   no record of hearings or judgments.
7. The fee is not added to what the borrower owes on the sheet (the judge decides whether it's awarded).
8. An unpaid fee nags after one day; the fee amount is a setting rather than per-case typing.
