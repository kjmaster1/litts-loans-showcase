# Claude Code notes from the production repo — Litt's Loans

> Snapshot of the production repo's `CLAUDE.md` (the instructions Claude Code reads in every
> session), kept here to show how the project is run. It describes the private production
> setup, which is not part of this showcase copy. The `docs/research/` and
> `docs/operations/` files it points to stay private.

Internal staff web app for **Litt's Loans**, a lending business on a GTA V roleplay
(FiveM) server. Must feel and behave like enterprise finance software. The owner
(CEO character Kieran Jones, State ID 3454) wants frequent questions on decisions.

## Status (2026-11-10)

All six phases are done and in production, plus the rounds since (QA, UX, origination, data-quality fixes, the
2026-10-13 review). What was built when, and where each piece is documented: `docs/CHANGELOG.md` — add a line there
at the end of every session. Latest: Legal cases — defaulted loans' case sheets for the outside lawyer, Hand to Legal,
the attorney & filing fee (migration 0036, research/21); a contract note for Legal (0037); 742 tests +
48 browser tests.

- **Deployed**: by GitHub Actions on every push to `main` that
  passes the checks and the browser tests (`docs/operations/DEPLOYING.md`). Owner's CEO account exists.
- **Database roles (2026-10-13)**: the app connects as `litts_app` (Vercel `DATABASE_URL` is now a manual Sensitive
  variable; the Neon integration was disconnected from the project). Backups/checks should use `litts_readonly`
  via `BACKUP_DATABASE_URL` (verified in `pg_stat_activity`). Only migrations and `.env.prod-admin` use the owner.
  "permission denied for table …" in production = a connection string naming the wrong role.

## Read first

- `docs/SPEC.md` — product & technical spec v0.2 (roles matrix, imports, ledger,
  commissions, security, UX, phases).
- `docs/decisions/0004-bank-export-times-are-utc.md` — why bank times are read as UTC; the one edit of ledger dates.
- `docs/research/01–04` — verified analysis of the in-game data and all owner answers
  (tax model, loan/mortgage flows, game bugs, guidelines, staff roster).
- `docs/decisions/` — ADRs: 0001 hosting/auth/scope/timezone, 0002 no four-eyes
  (step-up + reason instead), 0003 dynamic rendering + nonce CSP (cacheComponents off).
- `docs/security/SECURITY.md`, `docs/design/DESIGN-SYSTEM.md`, `docs/design/LEDGER.md`
  (chart of accounts, tax treatment, classification, pairing, import pipeline).
- `docs/research/05` — manual-comment classification answers; `06` early-repayment bugs.
- `docs/design/LOANS.md` — loan identity, linking, matching, status, loan accounting.
- `docs/design/MORTGAGES.md` + `docs/research/07` — mortgages, tablet format, allowance.
- `docs/design/COMMISSIONS.md` + `docs/research/08` — commission scheme, weeks, payouts.
- `docs/research/09` — Phase 6 decisions (old loans, reports, passkeys, GitHub/CI).
- `docs/research/10` — commission before the scheme: catch-up period + officer suggestions.
- `docs/research/11` — feature review answers (backups, settings, pay sheet, lend check,
  collections, forecast, performance report, staff loans). Declined: period lock,
  private-loan rate sign-off, Discord digest.
- `docs/research/12` — improvement review answers (ECL figure only, no payoff quotes or
  statements, in-app notifications, mostly one user → no task queues).
- `docs/research/13` — recoveries from court judgments matched to the bank; Arlo's fix;
  password reset.
- `docs/research/14` — net-to-Litt's audit (books = bank on all 85 loans), matcher fix,
  game quirks.
- `docs/audit/AUDIT-2026-10-10.md` — full financial audit (books reconcile; findings F1–F9:
  repeated legacy banker fees, legacy-mortgage rows filed as loan money, game-error refunds off
  their loans, early-repayment rescaling, overdue +2% penalty). Re-run with `scripts/audit/`.
  Owner's answers applied: legacy-mortgage fees/payments refiled (categories
  `mortgage.legacy_banker_fee`, `…_refund`), game-error refunds `loan.refund` → 4390 linked to the
  loan by wallet, forecast rescales after early repayment, old manual loans booked loan by loan
  (`restateLegacyByLoan`, rules in `domain/ledger/legacy-loans.ts`).
- The State's monthly "Tax Payment" record covers tax withheld since the previous record (not a
  calendar month) — 20/20 match exactly.
- `docs/research/15` + `docs/design/ORIGINATION.md` — loan offers/contracts and mortgage quotes.
- `docs/research/16` — commission paid to date per person (loans vs mortgages); wallet owners of old payouts.
- `docs/research/17` — federal mortgage maximums (banker fee + broker rate by band), enforced on quotes.
- `docs/research/18` — quote review notes (management → officer) and executive approval of mortgages over $1m.
- `docs/research/19` — Draft/Confirmed quotes, expected signing time, the allowance outlook on the Quotes page; the
  observed allowance rule (`o1-principal4`, adopted 2026-10-19).
- `docs/research/20` — renumbered houses: repayments link by payer, mortgages take the newest address (migration 0034).
- `docs/research/21` — legal cases: the owner's case-sheet format, Hand to Legal, the $2,750 attorney & filing fee
  (design + plan in `docs/superpowers/`).
- `docs/design/UX-PASS-2026-10-11.md` — second UX audit (research, findings, fixes).
- `docs/operations/BACKUPS.md` — backup layers, secrets, restore steps, monthly restore drill.
- `docs/operations/DEPLOYING.md` — CI deploys, secrets, kill switch, rollback;
  `docs/operations/MONITORING.md` — every scheduled check and what emails the owner.
- `docs/qa/QA-2026-10-11.md` — the bug hunt after the UX pass.
- `docs/qa/QA-2026-10-13.md` — the app against the phone, tablet and bank; how to re-run that reconciliation.
- `docs/design/CODE-REVIEW-2026-10-11.md` — the owner's harsh code review and what became of each point.
- `docs/design/UX-REVIEW-2026-10-12.md` — designer + first-time-user review: findings, fixes, what was left.
- `docs/design/TUTORIAL-2026-10-12.md` — the app tour: design, both passes, files.
- `docs/design/COPY-REVIEW-2026-10-12.md` — AI-sounding copy removed; how to write UI text now.
- `docs/design/REVIEW-2026-10-13.md` — full review (commission late arrivals, database roles, step-up, CI) and what
  became of each finding. `docs/CHANGELOG.md` — what was built when.

## Commands

`pnpm dev | build | lint | typecheck | test` · `pnpm check` (everything CI runs) · `pnpm db:up` (Docker Postgres 18 on
:54329) · `pnpm db:generate | db:migrate` · `pnpm auth:generate` ·
`pnpm staff:invite --state-id N --name "X" --role ceo` · `pnpm staff:reset-password --state-id N --reason "…"`
(break-glass reset link when nobody above the person can sign in; `:prod` variants) ·
`pnpm test:e2e` (browser tests against a running `pnpm build && pnpm start`; `E2E_SEED=1` loads the
fixtures through the UI on an empty database, as CI does).
Integration tests use DB `litts_loans_test` (rebuilt from migrations each run).
Ops scripts (`scripts/ops/`, plain `pg`, run by workflows): `health-check.mjs`, `verify-restore.mjs`,
`check-anchors.mjs` — each runs locally with `node --env-file=.env.local scripts/ops/<name>`.

## Architecture

- `src/domain/**` is pure business logic (parse, classify, post) — no I/O, unit-tested.
- `src/server/**` is server-only (DAL). `src/lib/**` is pure and client-safe
  (roles, permissions, csp, session-policy, `format.ts`, `money.ts`, `search.ts`).
- Who may see or change *which record*: `src/server/authz/rules.ts` only. What a role may do at all:
  `can(role, capability)` in `src/lib/permissions.ts`.
- Detail pages load data in `page.tsx` and render sections from a sibling `sections.tsx`.
- Server errors are recorded by `src/instrumentation.ts` (`onRequestError`) and `runAction` into
  `app_error` (`src/server/app-errors.ts`) for the daily health check.
- Pages: `requireViewer()` / `requireCapabilityPage(cap)`. Server Actions:
  `authorize(cap)` inside `runAction()`; they validate with Zod and return
  `ActionResult`. Never trust page-level checks for actions.
- Every mutation writes `recordAudit(tx, …)` in the same transaction.
- Better Auth = authentication only; roles live on `staff` (one per RP character,
  keyed by State ID). Schema-shaping auth options live in
  `src/server/auth/shared-options.ts` (shared with `scripts/auth-cli.config.ts`).

## Key domain facts (do not re-derive)

- Business wallet `69811362`. State wallets `69794349` (lending / legacy mortgages)
  and `69833729` (property loan origination). Tax escrow `69740396`.
- Incoming `Amount` is gross; `Tax ($)` is withheld at source. Monthly "Tax Payment"
  rows are records only — exclude from cash. Balance reconciles exactly this way.
- xlsx `Name`/`State ID` = initiator of the transaction, not the counterparty. The `Name` is the person's **current**
  name, on old rows too: never use it to recognise a row (`identityKey` leaves it out) or a person (use the State ID).
- Bank export timestamps are **UTC**, although the header says `TIMEZONE: UTC-5` (ADR 0004; believing it stored
  everything 5 hours late until migration 0024). In-game UIs show the viewer's local time with an explicit offset.
  Store UTC; company timezone Europe/London. Fingerprints hash the time + 5 h (`FINGERPRINT_CLOCK_SHIFT_MS`) so
  rows stored before the fix still match — never change that.
- Private loans: flat interest, borrower pays P/N × (1 + broker%); state % is NOT
  charged to the borrower — it is deducted from principal Litt's receives. Except early repayments: there the
  State's share is on top of what's credited (the borrower pays it), so they carry no levy (`levyFor`, 2026-10-13).
- Game early-repayment maths is buggy (charges interest on the payment; payoff
  never clears; occasional interest with no principal). Record actuals, compare
  to contract, flag.
- The phone's "n/N complete" counts regular **and late** repayments (a "Late Finance Repayment" pays a missed
  instalment); early repayments don't count. Use `instalmentsPaid` / `INSTALMENT_ROLES` (`domain/loans/analysis.ts`).
- The game doesn't keep the contract's due dates: each instalment is due one period after the previous one was paid
  (`gameDueDates`). Dates drift ~30 min a week and jump after a late payment. The contract schedule is for display;
  anything about being late uses the game's dates. A loan's stored next payment is the game's date from the bank
  (`nextPaymentDue`, loan sync); a card's "in N hours" counts from when it was copied, not pasted — never trust it
  over the bank.
- Tax on a payment going **out** is the recipient's: it never enters the tax memo (9000) and no State record includes it.
- After a missed payment the game adds 2% per missed payment (compounding) to every later instalment. The principal
  part's extra is a late fee, not principal (owner): every "principal received" sum subtracts `penalty_cents`, and the
  levy is computed on the instalment without it. The phone's "remaining" includes the 2% on what's still to pay.
- The game never charges broker interest on a loan's **final instalment** (32/33 loans
  paid on schedule). Forecasts leave it out (`FINAL_INSTALMENT_INTEREST_CHARGED`);
  the loan page marks it — and every other game bug — with a "Game quirk" badge.
- Some loans were set up with the State's rate above the broker rate (likely swapped in
  game) and lose money: paste warning + "Check this loan's rates" (research/14).
- Anything in the game's Complete tab is complete. No active legacy mortgages.
- Legal cases (research/21): every defaulted/written-off loan. The sheet's instalment is the latest card's amount (with
  the +2% penalties) × instalments left, always — even when the signed contract differs (an officer's one-off mistake):
  management can only add a note for Legal (`setContractNote`), never change the claim; days in default are London calendar days up to the hand-over, which freezes the
  sheet (`legal_case_handover`, append-only). A loan moved to Default **by hand** (card < 3 missed) defaulted on its
  **second** missed payment, not the stored `first_default_at` (the paste time); with no first-missed date on the card
  the date must be set by hand. The sync links an attorney & filing fee by the `#LC<n>` reference **plus** the borrower's
  name in its comment; anything else is a suggestion to confirm. Fee links are a history (`legal_fee_link`, newest row
  wins; `ACTIVE_FEE_LINKS`) — unlinking is management's. The lawyer's wallet is learned from the first referenced fee
  payment (`syncLegalFees`); there's no Staff page field for wallets. The generated comment starts `[LEGAL]` so the classifier files it
  as legal whatever the borrower's name. The Legal Team role is the outside lawyer: `canBeOfficer`
  (rules.ts) refuses them as any record's officer everywhere an officer is set; never suggested for the pool.
- Multiple loans per State ID are normal — never key a loan by borrower.
- Characters get renamed in the game: staff are renamed with the Staff page's Change name (`changeName`), never re-invited;
  everything links by State ID, so a rename only changes the name shown.
- Invited staff count as working staff before they accept (owner, 2026-10-10): they can be
  loan/mortgage officers, own a wallet, earn commission and sit in the pool
  (`WORKING_STATUSES` in `src/lib/roles.ts`). Only signing in needs `active`.
  Finished loans (completed/written off) and completed mortgages can name *any* staff
  member as officer, departed/suspended included (`RECORD_STATUSES`) — open ones can't.
- Commission is paid from the phone with the card's **Pay Employee** (State ID, amount, comment): a Transfer from the
  business wallet to a personal one fails. The pay sheet's phone helper (`lib/pay-helper.ts`, a bookmarklet) fills that
  form; the person presses Submit — it never sends anything itself.
- Commission: private loans 50% of interest received net of tax; mortgage bank
  fee split originator 20% / weekly pool 30% / company 50% (configurable).
- Guidelines (research/04) drive import *warnings*, never blocks. Exception: the **federal mortgage maximums**
  (research/17, `domain/mortgages/federal.ts`) — State-funded mortgages from 15 Oct 2026, band by down payment + loan,
  whole mortgage at its band's maximum banker fee / broker rate (settings). A quote over them can't be saved by anyone;
  a pasted agreement over them is still recorded (the game can't be stopped) but flagged and notified to executives.
- Mortgages over $1,000,000 down payment + loan (setting) need an **executive's approval** (research/18,
  `domain/mortgages/approval.ts`): on the quote before the tablet, else flagged. An approval covers the approved terms
  only — editing them clears it; a tablet agreement that differs from the approved quote isn't approved.
- Mortgage quotes are `draft` or `confirmed` (research/19): only confirmed ones draw on the projected allowance, at their
  expected signing time; a confirmed quote can be marked signed in game before its tablet paste; editing its money
  terms returns it to draft. The projection lives in `domain/mortgages/allowance-outlook.ts` and counts each repayment
  once, from `max(latest reading, end of the bank data)`; a mortgage is left out as behind only once an instalment
  is 2 hours overdue at the end of the bank data (`BEHIND_GRACE_MS`). Top-ups from the State appear only through readings.
- Loan identity = its `Loan Transfer` bank row. Terms come only from phone cards and
  are fixed once set (levies were posted with them). Write-off is the only status the
  app sets itself; a later paste never undoes it.
- Default/Overdue cards have no principal and no "every N days" line.
- Early-version payment comments state the **total repayable** (P × (1 + b)), not P — the
  linker accepts both. Correcting stored links is a reviewed action (`loans/relink.ts`).
- Mortgage identity = its "<addr>: Down Payment & Fees" in-row (addresses can be resold).
  Repayment gross includes federal interest, withheld as tax; Litt's keeps
  gross − tax − principal forwarded. The tablet's "Paid 1" counts the down payment.
- A mortgage's last instalment reads "<addr>: Final Loan Repayment" on both legs (first seen 5 Nov 2026), not "Loan Repayment".
  Early mortgage repayment doesn't exist in the game (owner, 2026-11-06). Keep the rule to that exact word: "Personal Loan
  Repayment" is something else, and wording the app doesn't know belongs in Needs review.
- Allowance rule is unknown (owner): never assume one — score candidates against readings.
- Commission: loan officer 50% of interest net of tax; banker fee 20% originator / 30% pool
  (equal shares) / 50% company; weekly mortgage broker interest is the company's. Every
  share is whole dollars. Payout `pay` rows: the *target wallet* is the recipient.
- Banker fee % is of **down payment + loan** (not price; price also includes agency commission).
- Mortgages can be **company-funded** (no Fed rate on the tablet; Litt's pays the State down +
  loan). Loan → 1120 receivable; repayments stay with Litt's. See MORTGAGES.md.
- The server renumbers house addresses **and gives old numbers to other houses** (research/20): a repayment links by
  its payer's State ID (`repaymentMortgage`), the address only telling a buyer's mortgages apart; never match by
  address against another known buyer. Tablets match by buyer + exact money when the address differs; the mortgage
  takes the newest address and old ones live in `mortgage.address_aliases`; merged duplicates have `merged_into_id`
  set and must be excluded from every query.
- Loan status = the phone tab the card is in (owner, 2026-10-09). An Active-tab card
  can show "OVERDUE: Missed payment 2/8 (1 missed)" and is still Active.
- The game only ever moves whole dollars (it rounds). Everything the app derives —
  levy, schedule, adjustments — goes through `wholeDollars()` (`src/lib/money.ts`).
  Levies posted under an older rule are trued up by the sync (correction entries);
  each completed loan's closing difference sits wholly in 4310 or 5110.

## Gotchas learned the hard way

- Next 16.4 ships its docs in `node_modules/next/dist/docs/` — read before using an API.
- `next build` refuses to run (`SecurityFatalError`) when the installed Next has a published advisory — CI can't
  deploy until it's bumped. `pnpm audit --prod --audit-level high` shows which; transitive pins go in
  `pnpm-workspace.yaml` `overrides` (2026-10-28: Next 16.4.0 → 16.4.3, Zod under `@vercel/cli-config`).
- Better Auth: `disabledPaths` only blocks HTTP; server `auth.api.*` still works.
  A refused sign-up returns a *synthetic success* — verify in the DB.
  User `after` hooks run *before* plugin hooks (two-factor rewrites responses later).
  `/two-factor/verify-totp` creates a new session for both sign-in and enrolment —
  distinguish by the `litts.two_factor` cookie.
- The Better Auth CLI can't load files importing `server-only`.
- Postgres `inet` normalises values — would break audit hashes; store IPs as text.
- Drizzle wraps PG errors; the PG message is on `error.cause`.
- Sonner injects a `<style>` without nonce support; its hash is pinned in
  `src/lib/csp.ts` and guarded by `csp.test.ts`.
- shadcn now uses Base UI (`render` prop, not `asChild`) and the `cn` package.
- Vercel `vercel integration add` drops agent-skill files (`.agents/`, `.claude/`,
  `skills-lock.json`) and re-appends `.env*` to `.gitignore` — clean both up.
- Vercel *Secret* env vars can't be read back; keep the local copy in sync.
- Postgres 18 Docker image mounts at `/var/lib/postgresql` (not `/data`).
- pg `sslmode=require` → pinned to `verify-full` (`src/lib/db-url.ts`).
- NEVER name a local env file `.env.production.local`: `next start` auto-loads it
  (it once pointed a local server at prod). Prod admin creds are `.env.prod-admin`.
- Bank export quirk: "Time" header is in column B, values in column A.
- Postgres can't store JS's max Date — open-ended periods use `END_OF_TIME` (9999).
- Base UI injects `<style>` (Select): wrapped in `CSPProvider nonce`.
- The ledger/journal tables reject DELETE/TRUNCATE; tests reset them with
  `session_replication_role = replica` (test superuser only) — `tests/support/db.ts`.
- Sensitive actions throw `StepUpRequiredError` (message `STEP_UP_REQUIRED`); the
  client wraps the call in `withStepUp(() => action())`, which asks for a code and retries.
- Bank rows linked to a loan can't be reclassified (the link and levy would go stale).
- Playwright: panels gated on `useNow()` render only after hydration — wait before
  asserting. `TaskStop` on `pnpm start` leaves `next-server` holding :3000 — a new `pnpm start`
  then fails with EADDRINUSE and tests silently hit the OLD build. Free the port (PowerShell
  `Get-NetTCPConnection -LocalPort 3000`) and wait for "Ready" in the new server's log first.
- Playwright on Windows can crash a worker (exit 3221225794 / 0xC0000142): an environment
  failure, not a test failure — re-run the affected specs.
- The 60-minute idle sign-out also expires saved Playwright sessions; re-sign-in when a crawl
  only reaches one page (it's looking at the sign-in page).
- Services used by CLI scripts must not import Next.js/Better Auth runtime modules: the
  step-up check lives in `src/server/auth/step-up-guard.ts` for that reason (CI checks
  `pnpm staff:invite` still loads).
- Passkeys: the Better Auth plugin doesn't require user verification; `audit-hook.ts`
  rejects authentication without the UV flag and gates registration on a fresh step-up.
- `SidebarInset` needs `min-w-0`, or a wide table widens the whole page.
- Settings are read with `getSettings()` (newest `company_setting`, defaults filled in);
  never hard-code commission rates, the write-off delay or mortgage guideline ranges.
- Record-level access rules live only in `src/server/authz/rules.ts` (`canSeeLoan`, `canSeeMortgage`,
  `canCollectOn`, `canAnnotateLoan`, `canAssignOfficer`, `canActOnOffer`, `canActOnQuote`, `officerScope`); never
  compare officer ids inline.
  Server-side aggregates pass `SERVER_AGGREGATE` instead of a viewer to `listLoans`/`listMortgages`.
- Backup secrets: `BACKUP_DATABASE_URL`, `BACKUP_PASSPHRASE` (GitHub Actions); the local
  copy of the passphrase is `.env.backup` (gitignored). Never print it. Deploy secrets:
  `MIGRATE_DATABASE_URL` (piped from `.env.prod-admin`), `VERCEL_TOKEN` (the owner's; renew yearly).
- `! gh secret set NAME` in this session shows no prompt and saves an EMPTY secret; the owner sets
  secrets in GitHub's web UI (or their own terminal). Never ask them to paste a secret into chat.
- Client lists that seed `useState` from props don't reset on `router.refresh()` — give
  them a `key` derived from the data (e.g. `SuggestedOfficers`).
- Old commission comments may contain `Â·` for `·` (mojibake) — `parseCommissionItems` handles it.
- The anonymised fixture keeps old "Commission Pay" comments consistent with its borrower names.
- Next 16.4's `error.tsx` gets `retry` (not `reset`) — see the bundled docs.
- Every client `<form>` needs `method="post"` (or `"get"` for harmless filters): before
  hydration a method-less form GETs its fields into the URL — it once leaked passwords.
- No route-level `loading.tsx`: streaming fixes the status at 200 before `notFound()` /
  `redirect()` can run. Navigation feedback is `NavigationProgress`; programmatic
  `router.push` calls `startNavigationProgress()` first.
- `Button render={<Link/>}` bypasses Base UI's button (it would announce links as buttons or warn); list
  filters are `ViewTabs`; free text that can run long goes through `LongText`.
- A new sidebar place needs a line in `describe()` (`app-shell/tour-steps.ts`) — a test fails without it. The tour
  points at `data-tour` anchors (sidebar groups, `topbar`, `menu`, `account`); keep them when changing the shell.
  New e2e accounts dismiss the tour's welcome in `signUp` (`tests/e2e/support.ts`).
- Python edits on Windows: working copies are CRLF (`core.autocrlf`) — normalise before multi-line
  `replace` and assert every match, or the edit silently half-applies. Always `open(..., encoding="utf-8")`: the
  default is cp1252, which wrote "—" as a byte Turbopack refuses ("invalid utf-8 sequence", 2026-10-13).
- The app connects as `litts_app` once the owner switches over (migration 0030): it can't UPDATE/DELETE append-only
  tables or run DDL. A new append-only table's migration must `REVOKE UPDATE, DELETE ... FROM litts_app`
  (`database-roles.test.ts` finds tables by their delete-refusing trigger). Migrations and prod scripts use the owner.
- Commission weeks: closing needs a bank row dated after the week's end (`bankCovers`); money dated in a closed week
  that arrives later is carried into the next open week (`lateArrivals`), paid once by `source_tx_id` / the
  originator line's `mortgage_id`. Never move a closed week's lines.
- Inside a transaction, run queries one after another, not in `Promise.all` (one connection; pg warns and pg@9 drops
  it). `getWeek(key, now, tx)` is sequential for that reason.
- Step-up codes are single-use (`staff.step_up_counter` holds the last accepted TOTP step) and checked with the
  `two_factor` row locked. Tests that step up twice need codes from different 30-second steps.
- Look up user-supplied keys with `Object.hasOwn`, never `in` (`?sort=__proto__` crashed a page).
- "Expected to receive", "Interest to come" and the forecast all come from
  `loanInflows()` — change the maths there, nowhere else.
- The Edit/Write tools decode backslash-u escapes in their input; to put a literal
  escape in a file, or remove one, write the real character (e.g. ’) or use chr(92).
- Static `Alert`s must not be `role="alert"` (that announces on page load); pass the role
  only for errors that appear after an action.
- Bash heredoc + Python/JS string escapes have mangled regexes repeatedly — use
  the Edit tool for any replacement containing backslashes. Long heredocs with mixed
  quotes also fail in this shell ("unexpected EOF") — write the script/file with Write.
- Most phone cards (Default/Overdue/Complete) have no period: history and schedules
  assume weekly (`periodDays ?? 7`). The phone's own history is one paste deep, so
  anything "ever overdue" must also be derived from the schedule vs the bank.
- Never hash passwords with `auth.$context.password.hash` outside an auth endpoint: the
  breach-check plugin wraps it and throws "No auth context found" in production (tests
  disable that plugin). Use `hashPassword` from `better-auth/crypto`.
- Deploy by pushing to `main` (GitHub Actions migrates, then deploys). Don't run `vercel deploy`
  by hand — the CLI uploads the working folder, uncommitted changes included. Manual path only
  in emergencies (`docs/operations/DEPLOYING.md`). Prod one-off scripts:
  `node scripts/with-prod-env.mjs pnpm exec tsx --conditions=react-server <script>`
  (`getRequestMeta()` returns nulls outside a request).
- Investigating prod: a throwaway probe in `scripts/` (so `pg` resolves; plain `node` for .mjs, `pnpm exec tsx` to import
  domain code) inside `begin transaction read only` … `rollback`, deleted afterwards — never committed. Read-only
  transactions refuse temp tables (run a migration's selection as a CTE to preview it); raw SQL arrays of timestamps
  come back as strings (use `json_agg`). The audit scripts (`scripts/audit/`, esp. `e-sources`, `c-mortgages`,
  `d-other`, `a2-tax`) are the first thing to run on any "the numbers look wrong" report.
- Repairing prod data = a reviewed migration (0024–0028 pattern): select the rows generically (never hard-coded ids),
  `RAISE` on anything unexpected so the deploy stops with nothing changed, lift the immutability triggers only inside
  it, test it on a reproduction in `tests/integration`, preview its selection on prod read-only, and make a re-run a
  no-op. Loan/mortgage corrections made by the syncs land only on the next import or paste — ask the owner to do
  one after deploy, then verify read-only.
- Base UI Menu demands menu items only: a list with headers/buttons/links (the bell)
  must be a Popover, or axe fails `aria-required-children`.
- Contract templates (`reference/samples`) hold real names: tests use an anonymised example
  (Avery Lane, 40001). Contract text keeps the templates' straight apostrophes ("Litt's
  Loans"); app strings use ’.
- Every audit action needs a label in `src/lib/audit-labels.ts` (a test scans the source).
- `src/server/app-errors.ts` must not import `server-only` (it runs from `instrumentation.ts`).
- Auth endpoints are rate-limited per IP (2FA verify 5/min): repeated local e2e runs can trip it;
  the e2e sign-up waits and retries. The enrolment form says "Too many attempts" on 429.
- Every loan query must include `liveLoan` (`isNull(loan.retiredAt)`; raw SQL `retired_at is null`) — retired
  card-only loans are kept (their events are append-only) but must never be listed, matched or adopted.
- `loan_event`, `mortgage_event` and `loan_collection_action` are append-only (DB triggers): a merge can't move
  them — it leaves them on the retired record or refuses.
- A tablet paste only creates a mortgage when `problemsForNewMortgage` is empty; never weaken that to a warning.
- Pages never write to the database on load (owner review 2026-10-11): every write that brings
  in loan/mortgage/payout money runs `syncLoans` / `syncMortgages` / `syncPayouts` itself (import,
  pastes, reclassify). `mortgageSyncPending()` is a read-only check; a test and the daily health
  check assert nothing is left behind.
- Offers/quotes remember hand-unlinked matches (`excluded_loan_ids` / `excluded_mortgage_ids`); the
  syncs must keep skipping them.
- One `<main>` per page: the layout's `SidebarInset`. `PageBody` is a div; `#main` (skip link) is the
  title block. The sidebar is `<nav aria-label="Main">`. Run axe with `best-practice` too.
- Search text from the URL or a form goes through `cleanSearch()`; a typed number is a State ID
  only via `asStateId()` (≤ 9 digits) — NUL bytes and integer overflow were 500s (`docs/qa/QA-2026-10-11.md`).
- The allowance chart, `LocalTime` and datetime-local fields are the
  viewer's own. A signing time typed in the Confirm dialog is the browser's zone, stored as UTC.
- Intl `en-GB` short months say "Sept": use `dateFormat()` / `shortMonths()` (re-exported by
  `lib/format.ts`) or `dayMonth()` (`domain/commissions/week.ts`).
- Keyboard shortcuts ignore inputs, open menus/listboxes and open dialogs; new pages with a list
  search should use `ListSearch` so `/` finds it.
- Text formatting only via `src/lib/format.ts` (lint enforces it). Percent-of-money maths via
  `percentOfCents` (integer basis points) — except the State levy and loan analysis, which mirror
  the game's floating-point arithmetic on purpose (`levyFor` comment).

## Working agreements

- Ask the owner about domain uncertainties rather than guessing; record answers in docs.
- Research before implementing; record significant choices as ADRs.
- Verify UI changes in a real browser: `pnpm test:e2e` (committed suite) plus ad-hoc Playwright
  with local Chrome (`channel: "chrome"`); add a spec to `tests/e2e` for anything new.
- Don't deploy by hand: push to `main` and watch the CI run (`gh run list --workflow ci.yml`).
- Keep this file current at the end of each session.
- Real owner-supplied data lives in `reference/` (gitignored — never commit it). Tests use
  the anonymised copies in `tests/fixtures/` (`pnpm fixtures:anonymise`).
