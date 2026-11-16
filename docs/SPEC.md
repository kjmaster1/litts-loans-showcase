# Litt's Loans Platform — Product & Technical Specification

Version 0.2 (owner-reviewed) · 2026-10-09
Inputs: `docs/research/01–04`, `docs/decisions/0001–0002`.

---

## 1. Purpose and scope

An internal, staff-only system of record for Litt's Loans that **services** private
loans and mortgages created in-game, keeps **double-entry financial records** of the
business wallet, pays **staff commission** fairly, and tracks the **State mortgage
allowance**. It must look, feel and be secured like enterprise finance software.

**In scope:** imports (bank xlsx, phone loan cards, tablet mortgage details, allowance
snapshots), loan & mortgage servicing views, borrower lookup, contract-vs-actual
variance (game bug detection), default → charge-off → recovery, ledger and financial
reports, tax escrow memo, commission engine with weekly staff pool, staff/role
administration, full audit trail.

**Out of scope (by decision):** loan origination/approval workflow (ADR 0001), legal
case management (MDW in-game; the app only *prepares and hands over* a defaulted loan's case sheet, research/21), investor module, borrower-facing portal, extra borrower
KYC data.

---

## 2. Roles and permissions

Hierarchy: **Owner → CEO, COO → Management → Legal Team → Loan Officer.**
Permissions are additive up the hierarchy. All checks are enforced server-side in one
policy module; the UI only hides what the server would refuse anyway.

| Capability | Officer | Legal | Mgmt | CEO/COO | Owner |
|---|:-:|:-:|:-:|:-:|:-:|
| View own loans/mortgages (full detail) | ✔ | ✔ | ✔ | ✔ | ✔ |
| Borrower lookup by State ID (history summary) | ✔ | ✔ | ✔ | ✔ | ✔ |
| View all loans/mortgages | | ✔ | ✔ | ✔ | ✔ |
| Paste-import loan cards / mortgage details | ✔ | ✔ | ✔ | ✔ | ✔ |
| Assign issuing officer at import | ✔ (self) | | ✔ (any) | ✔ | ✔ |
| Reassign officer, edit loan metadata, collateral | | | ✔ | ✔ | ✔ |
| Record seizure / recovery, default notes | | ✔ | ✔ | ✔ | ✔ |
| Upload bank xlsx export | | | ✔ | ✔ | ✔ |
| Reclassify bank transactions | | | ✔ | ✔ | ✔ |
| Charge off a loan | | | ✔ ‡ | ✔ ‡ | ✔ ‡ |
| Merge a duplicate mortgage / remove a mistaken card-only loan | | | ✔ ‡ | ✔ ‡ | ✔ ‡ |
| Company financials (P&L, cash, tax, allowance) | | | ✔ | ✔ | ✔ |
| Own commission statement | ✔ | ✔ | ✔ | ✔ | ✔ |
| All commission statements, pool roster lock, mark paid | | | ✔ | ✔ | ✔ |
| Settings (rates guidance, commission %, charge-off weeks) | | | | ✔ ‡ | ✔ ‡ |
| Invite/deactivate staff; assign roles below own | | | ✔ (≤ Legal) | ✔ (≤ Mgmt) | ✔ (all) |
| Reset another user's 2FA | | | | ✔ ‡ | ✔ ‡ |
| Audit log viewer | | | ✔ (own team) | ✔ | ✔ |

‡ **Sensitive action:** requires step-up re-authentication (fresh 2FA) and a written
reason, is reversible, and appears in the Owner/C-suite sensitive-actions feed
(ADR 0002 — no second approver, since the CEO is mainly the sole operator).

No one can grant a role equal to or above their own, nor act on their own account's
role or 2FA. The Owner account cannot be deactivated except by itself, with step-up
auth.

---

## 3. Domain model (summary)

```
Staff (State ID, role, status, wallet IDs learned from payouts)
Borrower (State ID, name[s] seen)               1 ─< Loan, Mortgage
Loan        id, game_loan_ref (24-hex), disbursement_ref (uuid), borrower,
            officer, principal, n_instalments, period_days, broker_rate,
            state_rate, status, opened_at, collateral[], notes
Mortgage    id, property address, buyer, real-estate agency+agent, officer,
            price, down payment, loan amount, broker rate, fed rate, term,
            weekly payment, late fee, grace days, broker fee, agency commission
LoanSnapshot   every paste import of a card (raw text + parsed fields) — history
BankTransaction  raw imported row (immutable) + fingerprint + classification
JournalEntry / JournalLine   double-entry ledger (immutable, reversals only)
CommissionAccrual · PoolWeek · PoolRosterEntry · Payout
AllowanceSnapshot · AllowanceExpectedMovement
ImportBatch (source, file hash, uploader, counts, status)
AuditEvent (append-only, hash-chained)
```

Loan status machine:

```
Active ──missed──▶ Overdue(1–2 missed) ──3 missed──▶ Defaulted ──N weeks + 4-eyes──▶ Charged-off
   │                      │                              │                               │
   └──────────────────────┴────────── paid in full ──────┴──────▶ Completed    recoveries ┘
```

Status is driven by imports (game is source of truth) except Charged-off, which is a
company accounting decision (Mgmt+, sensitive action, eligible after N weeks — default 4).

---

## 4. Imports

Every import follows **upload/paste → parse → staged preview → commit**. Nothing
touches the ledger until a human confirms the preview. Each commit is one database
transaction and one `ImportBatch`; batches can be reversed by
posting reversal entries — never deleting (sensitive action, ADR 0002).

| Source | Who | Parser | Key |
|---|---|---|---|
| Bank export `.xlsx` | Mgmt+ | Header block + table; times are UTC despite the `UTC-5` label (ADR 0004) | Fingerprint + occurrence index (handles overlapping ranges) |
| Phone loan cards (Active/Overdue/Default/Complete paste) | All | Tolerant state machine anchored on `$x.xx` lines; accepts known game typos | Borrower State ID + principal + N + rates → matched to loan; ambiguity → user picks |
| Tablet mortgage details paste | All | Label/value pairs ("Down payment", "Loan amount", …), party block | Address + buyer State ID |
| Allowance snapshot | Mgmt+ | "State Allowance Balance $n" line or manual entry | Timestamped observation |

Preview shows: new / updated / unchanged / conflicting records, field-level diffs,
classification of each bank row with confidence, and warnings (rates outside company
guideline, Complete-tab residual ignored, float residue rounded, unmatched rows).

**Guideline checks** (effective-dated settings, see `research/04`): private loan rate
outside 10–25% requires recording the executive who signed off; mortgage broker rate
> 7.5% (state max) or fed rate < 3% = breach; broker rate outside 3–7%, fed rate < 10%
for a buyer who already holds a Litt's mortgage, banker fee outside 5–15% **of property
price** = warning. LTV and weekly payment shown on every deal. Warnings never block —
the game is the source of truth.

### Bank transaction classification

Deterministic rule table (regex on comment + type + direction + counterparty wallet),
versioned in code, with manual override (audited). Initial rules derived from the
1,922-row export:

| Pattern | Category |
|---|---|
| out `Loan Transfer <uuid>` | Loan disbursement |
| in charge `Broker Fee: Paid Broker Fee` | Origination fee |
| in `Subscription payment …` | Loan principal repayment (+ state levy) |
| in `Broker percentage payment: Loan Agreement…` / `OVERDUE…` / `DEFAULTED…` | Loan interest income |
| in `Broker percentage payment: Mortgage Agreement…` | Legacy mortgage broker income |
| in `Early Finance Repayment` / `… Broker Interest` | Early principal / early interest (paired ±2 s) |
| in `Late Finance Repayment` | Late principal |
| in `<addr>: Down Payment & Fees` | Mortgage origination receipt |
| out `<addr>: Property Loan & Fees` → 69833729 | Mortgage pass-through to State |
| in `<addr>: [Final ]Loan Repayment` / out → 69794349 | Mortgage instalment in / principal pass-through |
| out pay `Employee Pay: …Commission…` | Commission payout |
| out pay `Employee Pay: …Reimbursement…` | Reimbursement |
| out pay `Employee Pay: Attorney…/Lawyer…` | Legal fees |
| in seize `Government Seizure …` | Recovery |
| in deposit `Cash Deposit: …Investment…` | Capital contribution |
| out deposit `Tax Payment` → 69740396 | Tax escrow memo (non-cash) |
| legacy `Charge: Loan #n …` / `Employee Pay: $X Loan …` | Legacy manual loan repayment / disbursement |
| anything else | **Unclassified** — must be resolved before period close |

---

## 5. Servicing views

**Loan detail:** terms; contract schedule (flat interest, `P/N × (1+b)` per
instalment); actual payments (from bank rows) laid against the schedule; **variance
panel** (contract vs actual interest, flagged Bug A/B/C from research 02); status
timeline from card snapshots; officer; collateral; notes; commission accrued/paid.

**Mortgage detail:** parties (as tablet), terms, derived 52-week (or term) schedule,
receipts matched by address, State pass-throughs, Litt's margin per instalment,
fee split (originator / pool / company), allowance effect.

**Borrower page:** all loans/mortgages for a State ID, totals borrowed/repaid, missed
payments, defaults, charge-offs; staff-borrower conflict badge.

**Worklists:** Due this week, Overdue, Defaulted (age, charge-off eligibility),
Unclassified bank rows, Unmatched receipts, Loans without officer.

---

## 6. Ledger and financial reporting

Double-entry, integer cents (`bigint`), USD. Journal entries are immutable; DB
constraint guarantees Σdebits = Σcredits per entry; corrections are reversals.
Balances are derived (with materialised views for speed).

Chart of accounts (initial):

```
1000 Cash – Business wallet 69811362
1100 Loans receivable – principal         1110 Mortgage pass-through clearing
1150 Allowance for credit losses (contra)
1200 Commission advances
2000 Commissions payable                  2100 Due to State (mortgage principal)
3000 Owner/partner capital                3100 Retained earnings
4000 Loan interest income                 4010 Early-repayment interest income
4100 Mortgage broker fee income           4110 Mortgage broker interest income
4200 Origination fee income               4300 Recoveries
5000 Commission expense                   5100 State loan levy (s%)
5200 Tax withheld (escrow)                5300 Credit losses (charge-offs)
5400 Legal fees                           5900 Other operating expense
9000 Tax escrow memo (off-balance)        9100 State allowance memo (off-balance)
```

Reports (Mgmt+): P&L by period; cash reconciliation (derived balance vs the export's
reported "Amount" — must match to the dollar, as verified); portfolio (outstanding
principal, delinquency buckets, default rate by officer and rate band); tax report
(withheld by month vs "Tax Payment" memos); allowance tracker (expected vs observed);
State levy cost; commission summary. Exports to CSV.

---

## 7. Commissions

- **Private loans:** for every interest receipt on a loan, accrue 50% × (amount − tax
  withheld) to the loan's officer. No receipt → no accrual (matches "stops when the loan
  stops paying").
- **Mortgages:** for every broker fee received: 20% originator, 30% to the week's
  staff pool, 50% company. Percentages in settings, effective-dated (changes never
  rewrite history).
- **Weekly pool:** Monday 00:00 → Sunday 23:59 in the **company timezone
  `Europe/London`** (follows UK DST; configurable). The app pre-fills eligibility from activity signals with evidence;
  Management+ adjusts and **locks** the roster; amounts split equally among eligible.
- **Payouts:** statements per person per week; mark-paid is matched automatically
  to later imported "Employee Pay" rows (target wallet ↔ staff wallet). Late payouts
  are visible as ageing payables.

---

## 8. Security architecture

Built against OWASP ASVS 5.0 Level 2 and NIST SP 800-63B-4 (AAL2).

- **Accounts:** invite-only (signed, single-use, 48 h links); no self-registration.
- **Passwords:** min 12 chars (NIST permits ≥ 8 with MFA; we go further), max ≥ 64,
  no composition rules, **breached-password check** (HIBP k-anonymity), no forced
  rotation; hashed with scrypt/argon2id via Better Auth.
- **MFA mandatory:** TOTP enrolment forced at first login; passkeys optional; 10
  one-time backup codes. 2FA reset of another user only by Owner/CEO/COO (sensitive
  action; target's sessions revoked, forced re-enrolment).
- **Sessions:** HttpOnly, Secure, SameSite=Lax cookies; server-enforced **60 min idle (15 until 2026-10-11) /
  12 h absolute**; session list with remote revoke; re-auth (step-up) for sensitive
  actions (role change, settings, charge-off, import reversal, payouts).
- **Abuse controls:** rate limiting + progressive lockout on login/2FA; generic
  error messages.
- **Web hardening:** strict CSP with nonces, HSTS, frame-ancestors none,
  Referrer-Policy, Permissions-Policy; CSRF protection on mutations; input validation
  with Zod at every boundary; xlsx parsed server-side with size/row limits, no macros.
- **Authorization:** single policy module; every server action/route checks
  role + ownership; tests cover the full matrix in §2.
- **Audit:** append-only `audit_event` table (UPDATE/DELETE revoked at DB level),
  hash-chained so tampering is detectable; records actor, action, before/after,
  IP, user agent.
- **Data:** Neon encryption at rest, TLS in transit, point-in-time restore; least-
  privilege DB roles (app role cannot alter audit/ledger history); secrets only in
  Vercel env.
- **Supply chain:** lockfile, Dependabot/Renovate, `pnpm audit` in CI.

---

## 9. UX and design system

- **Principles:** clarity over decoration; exceptions surfaced first (worklists);
  every number traceable to source rows (click-through from report → journal → bank
  row → import batch); no dead ends.
- **Theme:** light + dark, follows OS, user toggle. Palette from the logo
  (`research/04`): brand green `#59B280` (darkened shade for text/actions in light mode
  — raw green fails contrast on white), money teal `#75ACA8`, cream `#F2F0E2`,
  charcoal `#505050`, ink `#1B1D1B`. Wordmark: "Litt's" light italic + "LOANS" heavy
  condensed italic; semantic colours for status (on-track, overdue, defaulted, charged-off) that
  pass WCAG 2.2 AA in both themes and never rely on colour alone.
- **Type:** Inter (UI) with tabular numerals for all money; monospace for IDs
  (State IDs, wallet IDs, refs). Right-aligned numeric columns, consistent `$1,234`
  formatting, negative values in parentheses in financial reports.
- **Layout:** sidebar navigation grouped by job (Work · Portfolio · Finance · People ·
  Admin); global **⌘K command palette** (jump to State ID, loan, address, page);
  dense, sortable, filterable tables with saved views, sticky headers and CSV export;
  detail pages with a summary header + tabs.
- **Accessibility:** keyboard-complete, visible focus, ARIA via Radix primitives,
  reduced-motion respected, 4.5:1 contrast minimum.
- **Responsive:** desktop-first (used alongside the game), fully usable on tablet and
  phone for lookups.

---

## 10. Technology

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js 16 (LTS), App Router, TypeScript strict | Server Components + Server Actions keep logic server-side; first-class on Vercel |
| DB | Postgres on Neon | ACID, constraints/triggers for ledger + audit invariants, PITR |
| ORM | Drizzle | SQL-first, TS schema, low cold-start on serverless |
| Auth | Better Auth (+ two-factor, passkey, admin plugins) | Self-owned user data, TOTP/passkeys/backup codes built in |
| UI | Tailwind CSS + shadcn/ui (Radix) + TanStack Table | Accessible primitives, full design control |
| Validation | Zod | Shared schemas client/server |
| xlsx | SheetJS (server-side) | Mature parser |
| Testing | Vitest (unit: parsers, calc, policy), Playwright (e2e) | Parsers are tested against the owner's real sample files |
| Jobs | Vercel Cron | Weekly pool close reminders, overdue ageing |
| Hosting | Vercel + Neon | ADR 0001 |

---

## 11. Delivery plan

| Phase | Outcome |
|---|---|
| 1 Foundation | Repo, CI, DB schema, auth (invite, password, mandatory TOTP, sessions), RBAC policy + tests, audit log, app shell & design system |
| 2 Bank import + ledger | xlsx import with dedup & classification, journal posting, cash reconciliation report (must match $185,331 on the sample) |
| 3 Loans | Card paste import, loan/borrower pages, schedule, variance (bug flags), worklists, charge-off + recoveries |
| 4 Mortgages + allowance | Tablet paste import, mortgage pages, fee split, allowance tracker |
| 5 Commissions | Accruals, weekly pool roster workflow, statements, payout matching |
| 6 Reports + polish | P&L, portfolio, tax, exports, ⌘K, accessibility audit, security review, deploy |

Historic data: load the full sample xlsx in phase 2; existing active loans are
created via card paste in phase 3 (completed loans stay in records only).

---

## 12. Resolved owner items (2026-10-09)

1. Four-eyes → rejected; step-up + reason + reversibility (ADR 0002).
2. Pool week Mon–Sun, company timezone Europe/London.
3. Lending guidelines captured (`research/04`) → import warnings.
4. Logo supplied (`b2945083-…png`).
5. Remaining staff State IDs entered at invite time.
