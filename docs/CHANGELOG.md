# Changelog

What was built, phase by phase and round by round, newest last. Moved out of `CLAUDE.md` on
2026-10-13 (review) so that file stays a working guide; each entry names the doc with the detail.

- **Phase 1 Foundation: done** — invite-only auth, mandatory TOTP, 60 min idle (was 15) /
  12 h absolute sessions, role policy, staff admin, HMAC-chained audit log, shell.
  2FA reset for another user and passkeys added in Phase 6.
- **Phase 2 Bank import + ledger: done** — xlsx import (preview → commit,
  idempotent across overlapping exports), classifier (`src/domain/bank/classify.ts`,
  RULESET_VERSION 1), double-entry ledger with DB-enforced integrity, mortgage
  pass-through pairing, reclassification by reversal, finance pages. Fixture
  reconciles to **$185,331**; 7/1,922 rows need review. 225 tests; verified in Chrome.
  Pending: "recognise legacy clearing (1190) as income" action (needs step-up).
- **Phase 3 Loans: done** — loans derived from bank disbursements + linked payments
  (`syncLoans`, idempotent, runs after every import/paste/reclassify); weekly paste of
  the 4 phone tabs (stateless preview → commit, officer assignment); State levy
  (5100), closing adjustments on completion (4310/5110), write-off (5300, step-up +
  reason, 28 days after default); contract schedule + game-bug flags; collateral,
  notes, borrower lookup. Step-up dialog (`StepUpProvider`/`useStepUp`) is generic.
  291 tests; verified in Chrome. Fixture: 85 loans, all cards matched.
- **Phase 4 Mortgages + allowance: done** — mortgages built from bank originations
  (`syncMortgages`, idempotent; runs after import, tablet paste and reclassify — never on page load),
  tablet "Sale Agreement" paste (preview → commit, several at once), weekly schedule
  (rounded down, last takes remainder — matches the tablet), payment state
  (on track / late in grace / behind), guideline flags, bank movements, officer from
  the tablet's FINANCE person. State allowance tracker (Management+): append-only
  readings (void with reason), candidate rules scored against readings, adopt a rule
  → expected balance. Borrower lookup includes mortgages. 321 tests; verified in Chrome.
- **Phase 5 Commissions: done** — scheme starts Mon 12 Oct 2026 (London weeks). Live
  weekly estimate; pool roster suggested from activity, confirmed + locked by
  Management+; closing a week freezes lines/awards (whole dollars) and books
  `Dr 5000 / Cr 2000`; payouts after the start are matched to people (by wallet, learned
  from the first manual assignment) and posted `Dr 2000 / Cr 5000`. Officers see their
  own figures. 342 tests; verified in Chrome. Also: company-funded mortgages (1120).
- **Phase 6 Reports & polish: done** — reports (P&L by month with previous period,
  balance sheet, loan & mortgage book, tax & commissions) with Excel download (audited);
  dashboard with headline figures + role-aware to-do list; passkeys (UV enforced, step-up
  to add); executive 2FA reset (step-up + reason); old manual loans booked 1190 → 4020;
  readable audit labels; GitHub Actions CI (private repo). 360 tests; verified in Chrome
  (incl. passkey add + sign-in with a CDP virtual authenticator).
- **Commission catch-up (2026-10-10)** — one-off period `/commissions/catch-up` for loan
  interest from 25 Aug to the scheme start that old hand-paid "Commission Pay" rows didn't
  list; officer suggestions from those rows' wallets. No migration. 375 tests.
- **Expected to receive (2026-10-10)** — dashboard card (finance viewers): loan principal
  excl. defaults + contract loan interest to come (`interestToCome`, card's completed
  count) + mortgage broker interest to come + company-funded mortgage principal; defaults
  shown separately. Loans page has an "Interest to come" KPI. 378 tests.
- **Feature round (2026-10-10, research/11)** — migration 0014: Settings page (versioned
  `company_setting`: commission rates, write-off days, mortgage guideline ranges; CEO+,
  step-up), commission **pay sheet** (one payment per person, `[COMM]` comment), **Can we
  lend?** on borrower lookup (red flags + `borrower_flag` do-not-lend), **Collections**
  (`loan_collection_action` log + queue + dashboard to-do), weekly **cash-flow forecast**
  (Finance), **Loan performance** report, **backups** (nightly encrypted `pg_dump` via
  `.github/workflows/backup.yml`, 30 days; Settings → Download everything), old staff
  loans clean-up (2200 → 3200/5150). 395 tests. Ops: `docs/operations/BACKUPS.md`.
- **Redesign (2026-10-10)** — `docs/design/REDESIGN-2026-10.md` + `DESIGN-SYSTEM.md`:
  charcoal 10-item sidebar, Finance tabs, Ctrl/⌘K search (`search-action.ts`), Add data
  menu, `StatStrip`/`Kpi`, tinted `Alert` variants, `RowLink`, `SortHeader`, SVG charts,
  loading/error/not-found. axe-core: 0 WCAG A/AA violations (both themes).
- **QA pass (2026-10-10)** — `docs/qa/QA-2026-10-10.md`: 14 findings fixed (forms posted
  from before hydration leaked passwords into URLs; `?sort=__proto__` crash; plain-English
  validation; 320 px reflow; Expected-to-receive = forecast via `loanInflows`; cut-off
  card pastes refused; real 404s via a progress bar instead of `loading.tsx`). 403 tests.
- **Improvement round (2026-10-10, research/12)** — migration 0015 (collections on
  mortgages: `loan_collection_action.mortgage_id`, exactly one target; `notification_read`).
  Borrower profile `/loans/borrowers/[stateId]` (`server/borrowers.ts`; the lookup page is
  now search → profile); promise-to-pay outcomes from the bank (`domain/loans/collections.ts`:
  kept/pending/broken) and a priority-ordered queue incl. late mortgages; notification
  bell (`server/notifications.ts`, computed per viewer, only read-state stored; Base UI
  Popover); Portfolio health report (`domain/health.ts`: status at any date rebuilt from
  schedule + bank, roll movement, collection rate, vintages); expected losses as a figure
  (`domain/risk.ts`, `server/risk.ts`) + realistic book value on the dashboard; net to
  Litt's per loan/mortgage from the books (`server/profit.ts`) on detail pages, profile and
  Loan performance (+ concentration, by borrower, mortgages by officer, best/worst);
  Excel on Loans/Mortgages/Collections/Transactions (`server/list-export.ts`, audited
  `list.exported`); "Data as of" notes (`server/freshness.ts`); recently viewed in Ctrl+K
  (localStorage per staff id). 418 tests; browser + axe clean both themes, 320 px.
- **Recoveries + password reset (2026-10-10, research/13)** — migration 0016. Executives
  issue one-time password reset links from Staff (`server/staff/password-reset.ts`,
  `/reset-password/[token]`). Category `recovery.settlement`; recovery rows naming one
  defaulted borrower link to the loan (role `recovery`); old-loans close-out can be
  corrected out of 4020. Arlo Oswin's 6 settlement payments refiled in prod. 428 tests.
- **Net audit + financial audit (2026-10-10, research/14, `docs/audit/`)** — books = bank on all 85
  loans; matcher fix for same-second payments; game quirks badged; audit follow-ups F1–F9 applied
  (legacy-mortgage categories, refunds → 4390, forecast rescale, old loans booked loan by loan).
- **Origination (2026-10-10, research/15)** — migration 0019 (`loan_offer`, `mortgage_quote`).
  `/loans/new` prices a private loan (rate guide from handbook §4C + record, checks as
  warnings, State rate always 1%), issues a frozen contract (vehicle/property templates word
  for word + a personal-loan template; copy as text) and an "Enter in the phone" checklist;
  the loan sync marks an issued offer funded and compares the card with the contract.
  `/mortgages/quotes/new` reproduces the tablet to the dollar (`quoteMortgage`) with §4A
  checks and a copyable tablet checklist; matched to the mortgage by the mortgage sync.
  Capability `loans.originate`. Toasts use the app's tokens (Sonner's green failed AA).
  Design: `docs/design/ORIGINATION.md`. 458 tests. Team visibility (2026-10-11): everyone who
  originates sees all offers/quotes, only the officer or management changes them; Quotes page
  shows State allowance left − open quotes (`allowanceLeft`, `quotePipeline`). Wrong automatic
  matches: "Not this loan/mortgage" unlinks (remembered in `excluded_loan_ids` /
  `excluded_mortgage_ids`, migration 0021) and "Link a loan/mortgage…" links by hand. Colleagues may
  see a paid-out offer's card-vs-contract comparison (owner).
- **UX pass (2026-10-11)** — `docs/design/UX-PASS-2026-10-11.md`: borrower directory
  (`domain/borrowers/directory.ts`, Excel), **My work** for officers (`server/my-work.ts`;
  `/` redirects roles without `dashboard.company`), keyboard shortcuts (`?`, `/`, G/N + letter,
  off switch), readable + linked audit subjects (`auditTarget`; test guards labels), settings
  sticky save bar, pinned P&L first column, `AffixInput` money fields, three-letter months,
  one `<main>` landmark + sidebar `<nav>`. 468 tests; Chrome + axe (incl. best practice) clean.
- **Bug hunt (2026-10-11)** — `docs/qa/QA-2026-10-11.md`: NUL bytes / overlong numbers in searches
  were 500s (`lib/search.ts`), audit paging overflow, clearer quote errors, control characters in
  forms, rate-limited 2FA enrolment message.
- **Operations (2026-10-11, owner review)** — deploys only from GitHub Actions (`ci.yml`: check →
  migrate live DB → `vercel deploy --prod` → smoke check; kill switch: repo variable
  `DEPLOY_FROM_CI`); `docs/operations/DEPLOYING.md`. Browser tests committed (`tests/e2e`,
  `pnpm test:e2e`, nightly `e2e.yml`). Server errors → `app_error` (migration 0020,
  `src/instrumentation.ts`); daily `health.yml` + monthly `restore-drill.yml` email via GitHub
  (`docs/operations/MONITORING.md`). Idle sign-out 60 min. Activity: ~8 loans and 10–40
  mortgages a month, DB 16 MB — per-request recomputation is fine at this scale.
- **Code review fixes (2026-10-11)** — `docs/design/CODE-REVIEW-2026-10-11.md`: no writes on page
  load; `lib/format.ts` + lint rule; loan/mortgage pages split into `sections.tsx`; exact
  `percentOfCents` maths; record-level rules in `server/authz/rules.ts` (+ `SERVER_AGGREGATE`);
  nightly audit anchors on the `audit-anchors` branch, checked daily. 490 tests + 17 browser tests.
- **Data-quality safeguards (2026-10-12)** — `docs/qa/DATA-QUALITY-2026-10-12.md`: a tablet paste copied
  from the heading became a mortgage "Sale Agreement - Financed". Parser finds the real address
  (`looksLikeAddress`); incomplete new mortgages refused (`problemsForNewMortgage`); possible duplicates
  need a decision (`duplicateCandidates`, commit `decisions`); `mergeMortgage` (capability `records.merge`,
  step-up); new loan cards need an explicit "add" and a stated amount; `retireCardOnlyLoan` (migration 0022
  `loan.retired_at`/`merged_into_id`); unconfirmed records flagged (`server/data-quality.ts`, dashboard,
  bell, health check). 515 tests + 19 browser tests.
- **UX review (2026-10-12)** — `docs/design/UX-REVIEW-2026-10-12.md`: designer pass + first-time-user pass, 17
  fixes. Top bar "New" menu (outline; one filled primary per page), shared `ViewTabs` (counts, focus ring),
  link-buttons stay links (`Button`), "Not pasted"/"Terms incomplete" mortgage badge, sign-in panel copy,
  `LongText` notes, schedule "Not paid"/"Next", new-loan field-level errors, loans view `live`
  (active + overdue) for "Assign loan officers", routine sign-ins out of dashboard activity. 25 browser tests.
- **App tour (2026-10-12)** — `docs/design/TUTORIAL-2026-10-12.md`: role-aware first-visit tour (welcome → one stop
  per sidebar group the role has → top bar → account menu → a first task), designed in two passes. Migration 0023
  (`staff.tour_completed_at`, `tour_role`); offered once to everyone, a promotion gets "what's new"; restart from
  the account menu. QA review before shipping (both docs). 523 tests + 30 browser tests.
- **Copy review (2026-10-12)** — `docs/design/COPY-REVIEW-2026-10-12.md`: all 3,738 UI strings read for AI tells;
  em-dash asides, the sign-in slogan panel, greetings, "platform", chatty tour lines and "Something went wrong"
  rewritten. Writing rules in `DESIGN-SYSTEM.md` ("Writing"); contracts and posted ledger memos unchanged.
- **Bank times fix (2026-10-13)** — ADR 0004: export times are UTC, not the header's `UTC-5`; every bank time was
  5 hours late (seen as "US time" on Transactions). Parser fixed; migration 0024 moves bank rows and the times copied
  from them (ledger dates, loan/mortgage starts, completions, estimated default dates); tested in
  `tests/integration/bank-times.test.ts`.
- **Early-repayment levy (2026-10-13)** — no State levy on early repayments (the game credits X(1−b−s) and the
  borrower pays the State's Xs on top). Onyx Greystone's loan showed −$156 outstanding; the sync's levy true-up
  reverses old levies and the closing surpluses that absorbed them on the next import or paste; on a written-off
  loan the correction goes to 5300.
- **Source reconciliation (2026-10-13)** — `docs/qa/QA-2026-10-13.md`: every loan's latest card, every tablet agreement
  and the bank checked against what the app shows (`scripts/audit/e-sources.ts`, re-runnable). Fixed: late repayments
  count as instalments paid; the game's due dates (a period after the previous payment) drive "Not paid"/"Next" and
  Portfolio health; disbursed/originated history events moved back 5 h (migration 0026); tax on outgoing payments out
  of the tax memo (migration 0025); no negative balances in the list; the phone's "remaining" shown on the loan page.
  Owner's answer: the +2% overdue penalty inside principal instalments is a late fee (audit F5) — `penaltyFor`,
  `loan_payment_link.penalty_cents` (migration 0027), booked by the loan sync. 537 tests + 34 browser.
- **Renamed customer imported twice (2026-10-13)** — QA-2026-10-13 "Later the same day": the export shows a person's
  current name on their old rows; Cyan's rename re-imported 2 rows (+$183,835 cash, a second mortgage). Import now
  matches rows without the name (`identityKey`); preview warns in red when the balance at the export's last row
  differs or new rows predate the books (warnings only, owner); migration 0028 removed the duplicates and merged the
  mortgage. 545 tests + 36 browser.
- **Next payment from the bank (2026-10-13)** — one copied text pasted twice 1 h 45 m apart put every active loan's next
  payment 1 h 45 m late (the phone only gives countdowns). The loan sync now sets it to the game's due date
  (`nextPaymentDue`); the card's countdown only while the bank is behind the phone; the paste preview warns about a
  repeated copy (`staleRepaste`). 552 tests + 37 browser.
- **Full review (2026-10-13)** — `docs/design/REVIEW-2026-10-13.md`: commission for money that arrives after its
  week closed is carried into the next open week, and a week can't close until the bank export reaches past its end;
  least-privilege database roles (migration 0030; owner switches the connection strings, `DEPLOYING.md`); step-up
  checked with the 2FA row locked and codes single-use (migration 0029, `staff.step_up_counter`); no row cap on
  `listLoans`; full export covers every table or says why not; notes audited; officer checks in `rules.ts`; "Mark
  repaid" needs step-up; CI: dependency audit, SHA-pinned actions, Dependabot, Node 24, browser tests gate deploys.
  576 tests.
- **Dependabot PRs (2026-10-13)** — merged TypeScript 6.0 and the four action majors (clears the Node 20 warning);
  closed `@types/node` 26 (production runs Node 24) and dropped `@better-auth/utils` 0.5 from the minor/patch group
  (Better Auth 1.7.7 pins 0.4.2; 0.5 installed a second copy of its core). Dependabot now groups actions and ignores
  both. CI runs on pushes to `main` and on PRs only (branch pushes ran it twice); integration `beforeAll` gets 30 s
  (a stalled runner timed one out at 10 s) and isolation is explicit (Vitest's `isolate: false` hint).
- **Commission paid to date (2026-10-14)** — read-only tally of every commission payout since 2025 by person, loans vs
  mortgages, with the owner's answers on unlinked wallets and the 7 Oct bonus (`docs/research/16`). Found Dwyane
  Benzy's 102 Sustancia Rd banker-fee commission ($4,661) never paid.
- **Federal mortgage maximums (2026-10-15)** — new State maximums for banker fee and broker rate by band of down
  payment + loan (`docs/research/17`). Settings hold the bands (the old 7.5–15% fee and 3–7%/7.5% broker ranges are
  gone); quotes over them can't be saved by anyone; over-maximum tablet agreements are flagged and notified to
  executives; quotes can be marked company-funded (exempt; migration 0031).
- **Quote review notes + executive approval over $1m (2026-10-15)** — Zion's request: management leave "what needs
  changing" notes on a colleague's quote; the officer marks them done with an optional reply (append-only, migration
  0032). Owner's rule: mortgages over $1,000,000 down payment + loan (setting) need an executive's approval — quotes wait
  for it (no tablet copy buttons until approved), unapproved tablet agreements are flagged and notified, executives can
  approve after the fact. Bell items for each step (`docs/research/18`). 606 tests + 39 browser tests.
- **Bell: read notifications came back on the next page (2026-10-15)** — the bell sits in each page's header and
  remounted on every navigation, re-seeding from the layout's list (loaded once, not re-fetched on client navigation).
  The bell's latest list now lives in `ShellProvider`; covered by the research/18 browser test.
- **Confirmed quotes and the State allowance outlook (2026-10-20)** — quotes are Draft or Confirmed (expected signing time,
  optional "Signed in game" mark); the Quotes page projects the allowance over 14 days and shows Fits/Tight/Short per
  signing; the owner adopted rule `o1-principal4` (`docs/research/19`). 653 tests + 42 browser tests. Migration 0033
  renames a status: push at a quiet time; expect a few minutes of errors while the deploy builds. Owner follow-ups the
  same day: the chart is in the viewer's own time; an instalment gets 2 hours' grace before its mortgage counts as
  behind; "fits from" stays as built.
- **Renumbered houses (2026-10-28)** — Zion's report: paid mortgages showed late after the server changed their
  address, and a reused number (115 North Rockford Dr) filed one buyer's repayment under another's mortgage.
  Repayments now link by who paid, the address only telling a buyer's mortgages apart; the mortgage takes the newest
  address and keeps the old ones (shown, searchable); tablet pastes and down payments don't match another buyer's
  record by address. Migration 0034 unlinks the misfiled repayment for the next import to relink (`docs/research/20`).
  Also Next 16.4.3 (critical advisories in 16.4.0 stopped `next build`) and patched Zod. 666 tests + 43 browser tests.
- **Phone helper for commission pay (2026-11-02)** — the owner pays commission from the phone page, where only the
  card's Pay Employee (State ID, Amount, Comment) works: Transfer fails from a business wallet to a personal one. The
  pay sheet shows each person's State ID and copies the whole sheet as a list; a bookmarklet on the phone fills Pay
  Employee per person and ticks them off when the owner presses Submit (it never submits). Checked on the real phone
  with a dummy row, cancelled (`docs/design/COMMISSIONS.md`). 669 tests + 44 browser tests.
- **Change name for staff (2026-11-02)** — a character renamed in the game (Cove Holloway → Cove Berry) had no way
  to be renamed once their invite was accepted. The Staff page's row menu now has Change name…: the same people who
  can change that person's role, never themselves. It renames the staff record and the sign-in account's name (the
  username stays), and audits the old and new name (`staff.name.changed`). Staff are recognised by State ID
  everywhere, so nothing re-matches; text the game wrote at the time (mortgage tablets, phone cards) keeps the old
  name. 670 tests + 45 browser tests.
- **Final mortgage instalment (2026-11-06, Zion's report)** — the game words a mortgage's last instalment
  `<addr>: Final Loan Repayment`, which the classifier didn't know. The first mortgage to reach its end (104 Forum Dr,
  Apt 1F, 5 Nov) had both legs left in Needs review ($404 there, $115 of tax booked as an expense, $289 of broker
  interest missing) and stayed at 4 of 5; staff can't choose mortgage categories by hand. The classifier takes the
  wording (ruleset 2), and migration 0035 re-posts rows stored before it; the next import pairs, links and completes.
  Also a bell test with a fixed-date mortgage that failed from 4 to 7 Nov. 677 tests + 45 browser tests.
- **Legal cases (2026-11-10, owner's request)** — the case summary the owner wrote by hand for the lawyer (`Name - ID`,
  instalment × left, fee per day × days in default, total, collateral) is generated for every defaulted loan on a new
  Legal cases page. Officers fill in the contract's fee per day and collateral when Legal asks (bell); Hand to Legal
  freezes the sheet; the $2,750 attorney & filing fee is paid by phone helper with a `#LC<n>` comment and linked from the
  bank. The outside lawyer gets a Legal Team login (never an officer option or pool suggestion). Migration 0036.
  Then the review's smaller items (locking, case numbers, suggestions, `[LEGAL]` comment tag…). 736 tests + 47 browser
  tests. `docs/research/21-legal-cases.md`.
- **Lawyer's wallet (2026-11-10)** — no Staff page field holds a staff wallet, so the fee sync learns the lawyer's wallet
  from the first fee payment it links by `#LC` reference (only if they have none and nobody else has it; audited). Fee
  suggestions for payments typed without a name need it. `docs/research/21-legal-cases.md`.
- **Contract note on a legal case (2026-11-10)** — two officers' contracts didn't match the game (one used the broker +
  State "total" rate). The sheet keeps claiming the phone card's amount; management can note on a case what the contract
  says and why it differs, shown to Legal beside the sheet (audited). Migration 0037; the State's 1% re-checked against
  the bank (withheld from what reaches Litt's, never charged to the borrower).
  `docs/research/21-legal-cases.md`.
- **2026-11-11 nightly browser-test fix** — the contract-note test left the pointer over the toast it was waiting to
  close (a toast under the pointer never closes), and its CI retry found the first attempt's note. The legal-case
  tests move the pointer away before waiting for a toast, and the note test removes a leftover note first. Test only.
- **Phone helper after the phone update (2026-11-16)** — the server gave Pay Employee an Employee dropdown and relabelled
  the State ID box "... or State ID"; the helper looked for "State ID" exactly and said Pay Employee wasn't open. It now
  drops a leading "... or" from labels and fills the State ID box, leaving the dropdown on "Select Employee".
