# Legal Case Sheets — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A defaulted loan gets a case sheet in the owner's exact format; officers fill in fee per day and collateral when
Legal asks; "Hand to Legal" freezes the sheet; the $2,750 attorney & filing fee is paid by phone helper and linked from
the bank; the lawyer works from their own Legal Team login.

**Architecture:** One pure module (`src/domain/legal/case-sheet.ts`) builds the sheet, the default date, the fee comment
and fee matching from plain inputs. A server module (`src/server/legal/cases.ts`) loads loans/cards/collateral/offers,
applies authz and performs the mutations. Fee payments are linked by a new `syncLegalFees(tx)` called at the end of
`syncLoans` (so every import, paste and reclassify runs it). Two pages under `/loans/legal`.

**Tech Stack:** Next.js 16.4 App Router (Server Components + Server Actions), TypeScript, Drizzle + Postgres 18, Zod,
Vitest (unit + integration), Playwright (e2e + axe), shadcn/Base UI components in `src/components/ui`.

**Spec:** `docs/superpowers/specs/2026-11-10-legal-case-sheets-design.md` (read it first).

## Global Constraints

- Follow `CLAUDE.md`: `recordAudit(tx, …)` in the same transaction as every mutation, with a label in
  `src/lib/audit-labels.ts`; Server Actions = `authorize()` inside `runAction()` + Zod; record-level rules only in
  `src/server/authz/rules.ts`; every loan query includes `liveLoan`; text formatting via `src/lib/format.ts`; every client
  `<form>` has `method="post"`; queries inside a transaction run sequentially; pages never write on load.
- Money in cents, whole dollars (`wholeDollars()`).
- Case statuses (derived, not stored): **Needs details**, **Ready**, **With Legal**, **Closed**.
- Who: *see a case* = `canSeeLoan`; *fill fee per day / unsecured / contract shared* = `canAnnotateLoan` (officer,
  Legal+); *ask the officer* = anyone who can see it; *Hand to Legal* and *correct the default date* = management+ or the
  loan's own officer (`canHandToLegal`); *close a case* and *hand over again (with reason)* = management+.
- A case can be handed over only when it's Ready: phone card present, default date known, fee per day > 0, and
  collateral recorded or *Unsecured* ticked.
- The sheet format is fixed by the owner's examples (Task 2 tests). Dates: London calendar, `July 21st 2026`.
- Fee: setting `legal.caseFeeDollars`, default **2,750**. Comment: `Attorney & Filing Fee - <Name> Default #LC<n>`.
  The game prefixes `Employee Pay: `. Unpaid-fee bell item after **24 hours**.
- Statuses of the loan considered: `defaulted` and `written_off` (both are pursued).
- Copy uses ’ in app strings; follow `docs/design/COPY-REVIEW-2026-10-12.md`. No new dependencies.
- Commits: one per task, message ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Don't push.

## Review Focus

1. **Loan moved to Default by hand** (card shows < 3 missed) — default date is first missed + one period, not the
   stored paste time. Pinned in Task 2 (`hand-moved default uses the second missed payment`: Zion → 6 Oct 2026).
2. **Two loans on one State ID** (Hollis Vance: one completed, one defaulted) — only the defaulted loan has a case; the
   fee/recovery matchers never pick by State ID. Pinned in Task 3 (`a borrower's completed loan has no case`).
3. **A new paste after hand-over** (instalment grows by +2%) — the frozen sheet text is unchanged. Pinned in Task 3
   (`hand-over is frozen against later cards`).
4. **Hand-typed fee comment without the `#LC` reference** — never auto-linked; shown as a suggestion to confirm. Pinned
   in Task 4 (`unreferenced fee payment is only suggested`).
5. **The lawyer's login** — must not appear as a loan-officer option or a suggested pool member. Pinned in Task 7.

---

## File Structure

| File | Responsibility |
|---|---|
| `drizzle/0036_legal_cases.sql` (+ `meta/`) | Loan columns, three tables, append-only trigger + REVOKE |
| `src/server/db/schema/legal.ts` (new), `schema/loans.ts`, `schema/index.ts` | Tables/columns |
| `src/domain/settings.ts`, `src/app/(app)/settings/settings-form.tsx` | `legal.caseFeeDollars` |
| `src/domain/legal/case-sheet.ts` (+ `.test.ts`) | Default date, days, sheet, text, fee comment, fee matching — pure |
| `src/server/authz/rules.ts` (+ test) | `canHandToLegal`, `canCloseCase` |
| `src/server/legal/cases.ts` | Loaders + mutations |
| `src/server/legal/fees.ts` | `syncLegalFees(tx)`; called from `src/server/loans/sync.ts` |
| `src/server/notifications.ts`, `notification-bell.tsx` | Two bell kinds |
| `src/app/(app)/loans/legal/page.tsx`, `[loanId]/page.tsx`, `actions.ts`, `case-forms.tsx` | UI |
| `src/components/data/phone-helper.tsx` | Moved from `commissions/phone-helper.tsx` (shared) |
| `src/components/app-shell/nav.ts`, `tour-steps.ts` | Sidebar + tour line |
| `src/server/loans/queries.ts`, `src/server/commissions/service.ts` | Lawyer exclusions |
| `tests/integration/legal-cases.test.ts`, `tests/e2e/legal-cases.spec.ts` | Tests |
| Docs | `docs/research/21-legal-cases.md`, `LOANS.md`, `SPEC.md` scope line, `CHANGELOG.md`, `CLAUDE.md` |

---

### Task 1: Schema, migration and the fee setting

**Files:**
- Create: `src/server/db/schema/legal.ts`, `drizzle/0036_legal_cases.sql` (via `pnpm db:generate`, then hand-add trigger/REVOKE)
- Modify: `src/server/db/schema/loans.ts` (loan table), `src/server/db/schema/index.ts`, `src/domain/settings.ts`,
  `src/app/(app)/settings/settings-form.tsx`
- Test: `tests/integration/settings.test.ts`, existing `tests/integration/database-roles.test.ts`

**Interfaces — Produces:**
- `loan.defaultFeePerDayCents: bigint number | null`, `loan.unsecured: boolean not null default false`.
- `legalCase` (mutable): `id uuid pk`, `number serial`, `loanId uuid unique → loan`, `defaultAtOverride timestamptz null`,
  `detailsRequestedAt / detailsRequestedByStaffId`, `contractSharedAt / contractSharedByStaffId`,
  `closedAt / closedByStaffId / closeNote text`, `createdAt`.
- `legalCaseHandover` (append-only, trigger `ledger_reject_mutation`, `REVOKE UPDATE, DELETE ... FROM litts_app`):
  `id uuid pk`, `caseId → legalCase`, `handedAt timestamptz`, `handedByStaffId`, `payeeStaffId → staff`,
  `feeCents bigint`, `sheet jsonb` (`CaseSheet`, Task 2), `text text`, `reason text null` (required when superseding).
  The newest row per case is the current hand-over.
- `legalFeePayment` (append-only, same trigger + REVOKE): `bankTransactionId uuid pk → bank_transaction`,
  `caseId → legalCase`, `method text` (`reference` | `confirmed`), `linkedByStaffId null`, `linkedAt`.
- Settings: `settings.legal.caseFeeDollars` (`dollars`), default `2750`, label `"Attorney & filing fee per case ($)"`.
  `resolveSettings` and `settingsChanges` include the `legal` group.

- [ ] **Step 1:** Add to `tests/integration/settings.test.ts`: `resolveSettings({})` has `legal.caseFeeDollars === 2750`;
  a stored version without `legal` resolves to the default. Run `pnpm test tests/integration/settings.test.ts` → FAIL.
- [ ] **Step 2:** Add the schema, setting and settings-form field; `pnpm db:generate`; append the trigger + REVOKE
  statements to the SQL (copy the 0014 trigger form and the 0030 REVOKE form).
- [ ] **Step 3:** `pnpm db:migrate` on the local DB; run settings + `database-roles` tests → PASS (the roles test finds the
  new triggers and checks the REVOKE).
- [ ] **Step 4:** Commit `Legal cases: schema, migration 0036, fee setting`.

### Task 2: The case sheet (pure)

**Files:** Create `src/domain/legal/case-sheet.ts`, `src/domain/legal/case-sheet.test.ts`

**Interfaces — Produces:**
```ts
export type CaseSheet = {
  borrowerName: string; stateId: number;
  instalmentCents: number; instalmentsLeft: number; claimCents: number;
  feePerDayCents: number; defaultedOn: string /* YYYY-MM-DD, London */; days: number; feeTotalCents: number;
  receivedCents: number; totalCents: number; collateral: string;
};
export function caseDefaultAt(i: { firstDefaultAt: Date | null; firstMissedAt: Date | null; missedPayments: number | null; periodDays: number | null; override: Date | null }): Date | null;
export function londonDay(at: Date): string;              // "YYYY-MM-DD"
export function daysBetween(fromDay: string, toDay: string): number; // calendar days
export function buildSheet(i: { borrowerName: string; stateId: number; instalmentCents: number; instalments: number; completed: number; feePerDayCents: number; defaultAt: Date; asOf: Date; receivedCents: number; collateral: string }): CaseSheet;
export function sheetText(s: CaseSheet): string;
export function feeComment(name: string, caseNumber: number): string;
export function feeReference(comment: string): number | null; // "#LC12" → 12
```
`caseDefaultAt`: `override` wins; else if `missedPayments !== null && missedPayments < 3 && firstMissedAt` →
`firstMissedAt + 1 × (periodDays ?? 7) days` (hand-moved: the second missed payment, owner 2026-11-10); else
`firstDefaultAt`. Text format: numbers with thousands separators; `$` only on the instalment, the per-day line, the
fee total and the final total; ordinal day via a small helper here (`1st 2nd 3rd 4th … 11th 12th 13th 21st 22nd 23rd`);
month names from `dateFormat` with `timeZone: "Europe/London"`. When `receivedCents > 0`, insert the line
`$<received> received since default` before the total and make the total line `<claim> + <fee> - <received> = $<total>`.

- [ ] **Step 1: Write the failing tests** (exact strings from the owner's examples, slips corrected):
```ts
test("Rowan Redgrave, handed over 6 Aug", () => {
  const s = buildSheet({ borrowerName: "Rowan Redgrave", stateId: 6661, instalmentCents: 804_700, instalments: 6, completed: 1,
    feePerDayCents: 20_000, defaultAt: new Date("2026-07-21T03:07:01Z"), asOf: new Date("2026-08-06T15:00:00Z"), receivedCents: 0, collateral: "Ocelot Jackal - G1YBEU4B" });
  expect(sheetText(s)).toBe("Rowan Redgrave - 6661\n\n$8,047 * 5 = 40,235\n\n$200 per day in default\n\nDefaulted - July 21st 2026\n\n200 * 16 = $3,200\n\n40,235 + 3,200 = $43,435\n\nCollateral - Ocelot Jackal - G1YBEU4B");
});
test("Hollis Vance", () => { /* 1_082_600 × (6−3), fee 10_000, default 2026-07-22T14:07:01Z, asOf 6 Aug → "$10,826 * 3 = 32,478", "100 * 15 = $1,500", "32,478 + 1,500 = $33,978", "Defaulted - July 22nd 2026" */ });
test("hand-moved default uses the second missed payment", () => {
  expect(caseDefaultAt({ firstDefaultAt: new Date("2026-10-09T20:02:18Z"), firstMissedAt: new Date("2026-09-29T11:58:02Z"), missedPayments: 2, periodDays: null, override: null })).toEqual(new Date("2026-10-06T11:58:02Z"));
});
test("game default keeps firstDefaultAt; override wins", …);
test("London day boundary: 23:30 UTC on 21 Jul (BST) is 22 Jul", …);
test("received line and subtraction", …);   // receivedCents 500_000 → "$5,000 received since default" and "40,235 + 3,200 - 5,000 = $38,435"
test("ordinals 1st 2nd 3rd 4th 11th 12th 13th 21st 22nd 23rd 31st", …);
test("feeComment / feeReference", () => {
  expect(feeComment("Rowan Redgrave", 12)).toBe("Attorney & Filing Fee - Rowan Redgrave Default #LC12");
  expect(feeReference("Employee Pay: Attorney & Filing Fee - Rowan Redgrave Default #LC12")).toBe(12);
  expect(feeReference("Employee Pay: Attorney & Filing Fee")).toBeNull();
});
```
- [ ] **Step 2:** `pnpm test src/domain/legal` → FAIL (module missing).
- [ ] **Step 3:** Implement the module.
- [ ] **Step 4:** `pnpm test src/domain/legal` → PASS.
- [ ] **Step 5:** Commit `Legal cases: the case sheet`.

### Task 3: Server — loaders, rules and mutations

**Files:**
- Create: `src/server/legal/cases.ts`, `tests/integration/legal-cases.test.ts`
- Modify: `src/server/authz/rules.ts` (+ `rules.test.ts`), `src/lib/audit-labels.ts`, `src/server/loans/collections.ts`
  (export a tx-taking helper to insert the `handed_to_legal` entry, or insert directly with the same `loanEvent`)

**Interfaces:**
- Consumes: Task 1 tables, Task 2 functions, `getSettings()`, `canSeeLoan`, `canAnnotateLoan`, `recordAudit`.
- Produces:
```ts
export const canHandToLegal = (v: Viewer, r: Owned) => can(v.role, "loans.reassign_officer") || own(v, r);
export const canCloseCase = (v: Viewer) => can(v.role, "loans.reassign_officer");

export type CaseState = "needs_details" | "ready" | "with_legal" | "closed";
export type CaseMissing = "card" | "default_date" | "fee_per_day" | "collateral";
export type CaseRow = { loanId: string; caseId: string | null; number: number | null; borrowerName: string; stateId: number;
  officerStaffId: string | null; officerName: string | null; state: CaseState; missing: CaseMissing[];
  preview: CaseSheet | null; handedAt: Date | null; feePaid: boolean; detailsRequestedAt: Date | null; contractSharedAt: Date | null };
export type CaseDetail = CaseRow & { handover: (typeof legalCaseHandover.$inferSelect) | null; earlierHandovers: number;
  feeCents: number; payee: { staffId: string; name: string; stateId: number } | null;
  feePayments: { txId: string; occurredAt: Date; amountCents: number; comment: string }[];
  feeSuggestions: { txId: string; occurredAt: Date; amountCents: number; comment: string }[];
  recoveredSinceHandoverCents: number; netForLittsCents: number; stillOwedCents: number; legalStaff: { id: string; name: string }[] };

export async function listCases(viewer: Viewer, now?: Date): Promise<CaseRow[]>;
export async function getCase(viewer: Viewer, loanId: string, now?: Date): Promise<CaseDetail | null>;
export async function setLegalTerms(viewer: Viewer, raw: { loanId: string; feePerDayDollars: number | null; unsecured: boolean }): Promise<void>;
export async function requestDetails(viewer: Viewer, raw: { loanId: string }): Promise<void>;
export async function markContractShared(viewer: Viewer, raw: { loanId: string; shared: boolean }): Promise<void>;
export async function setCaseDefaultDate(viewer: Viewer, raw: { loanId: string; date: string /* YYYY-MM-DD */ | null; reason: string }): Promise<void>;
export async function handToLegal(viewer: Viewer, raw: { loanId: string; payeeStaffId: string; reason?: string }, now?: Date): Promise<void>;
export async function closeCase(viewer: Viewer, raw: { loanId: string; note: string }): Promise<void>;
export async function confirmFeePayment(viewer: Viewer, raw: { loanId: string; txId: string }): Promise<void>;
```
Loader rules: cases = live loans with status `defaulted|written_off` visible to the viewer (`officerScope` for
officers). Instalment = latest card's `parsed.headerAmountCents`; instalments/completed from that card, else
`loan.instalments` / `loan.lastCompleted`. Fee per day = `loan.defaultFeePerDayCents ?? funded offer's
defaultFeePerDayCents`. Collateral = `loan_collateral` descriptions joined with `"; "`, else the funded offer's
`collateral`; `"None (unsecured)"` when `loan.unsecured`. `receivedCents` = `role = 'recovery'` links (amount − tax)
dated after the default date and before the hand-over (or now). Preview `asOf` = now. A `legalCase` row is created
lazily by the first mutation (`insert … on conflict (loan_id) do nothing returning`, then select).
`handToLegal`: requires `canHandToLegal`, state `ready` (or `with_legal` + `canCloseCase` + non-empty `reason` to hand over
again), payee must be an active/invited staff member with role `legal`; inserts the hand-over with
`feeCents = settings.legal.caseFeeDollars × 100`, frozen `sheet` + `sheetText`, plus a `loan_collection_action` of kind
`handed_to_legal` (note: `Case #LC<n> handed to Legal`) and a `loanEvent`, all in one transaction with the audit.
Audit actions + labels: `legal.terms_set`, `legal.details_requested`, `legal.contract_shared`, `legal.default_date_set`,
`legal.handed_over`, `legal.closed`, `legal.fee_confirmed`.

- [ ] **Step 1: Write failing integration tests** (`tests/integration/legal-cases.test.ts`, seeding like
  `loans.test.ts`): `a borrower's completed loan has no case` (two loans, one State ID → one case);
  `needs details until fee and collateral or unsecured`; `officer can set terms on own loan, not another's`;
  `Legal can request details but cannot hand over`; `officer hands over own loan; payee must be Legal`;
  `hand-over is frozen against later cards` (paste a card with a higher amount after hand-over → stored `text`
  unchanged, preview not used); `hand-over writes a handed_to_legal collections entry`; `second hand-over needs
  management and a reason`; `closing needs management`; `default date override changes the preview`.
  Add `canHandToLegal` / `canCloseCase` cases to `rules.test.ts`.
- [ ] **Step 2:** `pnpm test tests/integration/legal-cases.test.ts src/server/authz` → FAIL.
- [ ] **Step 3:** Implement rules, loaders, mutations, audit labels.
- [ ] **Step 4:** Run the same tests → PASS; `pnpm typecheck`.
- [ ] **Step 5:** Commit `Legal cases: loaders, rules and actions`.

### Task 4: Fee payments from the bank

**Files:** Create `src/server/legal/fees.ts`; Modify `src/server/loans/sync.ts` (call at the end of `run`), add tests to
`tests/integration/legal-cases.test.ts`.

**Interfaces — Produces:** `export async function syncLegalFees(tx: Tx): Promise<number>` — links every unlinked
`bank_transaction` with `direction = 'out'`, `category = 'legal'` and `feeReference(comment) = n` where case `n` exists
and has a hand-over, inserting `legalFeePayment { method: "reference" }`. Never links by name or amount.
Suggestions (read-only, in `getCase`): unlinked `legal` out-rows dated after the current hand-over whose normalised
comment contains the borrower's full name (`norm` as in `domain/loans/recovery.ts`).

- [ ] **Step 1: Failing tests:** `referenced fee payment links on import` (import a `pay` row with comment
  `Employee Pay: Attorney & Filing Fee - Avery Lane Default #LC1` → `feePaid` true); `unreferenced fee payment is only
  suggested` (comment without `#LC` → not linked, appears in `feeSuggestions`; `confirmFeePayment` links it with
  `method = "confirmed"`); `a reference to a case not handed over is ignored`; `re-running the sync adds nothing`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `Legal cases: link attorney & filing fee payments`.

### Task 5: Bell notifications

**Files:** Modify `src/server/notifications.ts`, `src/components/app-shell/notification-bell.tsx`; tests in
`tests/integration/legal-cases.test.ts`.

Kinds: `legal_details_requested` — to the loan's officer, while the case was requested and is still Needs details;
key `legal-details:<caseId>:<requestedAt ms>`; title `Legal needs the contract details for <name>`; href
`/loans/legal/<loanId>`. `legal_fee_unpaid` — to the hand-over's author and executives, from `handedAt + 24 h` while no
fee payment is linked; key `legal-fee:<handoverId>`; title `Attorney & filing fee not paid: <name>`; danger tone.

- [ ] **Step 1:** Failing tests for both kinds (appear / don't appear to others / disappear when resolved).
- [ ] **Step 2–4:** Run → FAIL, implement, run → PASS.
- [ ] **Step 5:** Commit `Legal cases: bell notifications`.

### Task 6: Pages

**Files:**
- Create: `src/app/(app)/loans/legal/page.tsx`, `src/app/(app)/loans/legal/[loanId]/page.tsx`,
  `src/app/(app)/loans/legal/actions.ts`, `src/app/(app)/loans/legal/case-forms.tsx`
- Move: `src/app/(app)/commissions/phone-helper.tsx` → `src/components/data/phone-helper.tsx` (update the import)
- Modify: `src/components/app-shell/nav.ts` (Work group, after Collections: `{ title: "Legal cases", href: "/loans/legal", icon: Gavel }`),
  `tour-steps.ts` `describe()` (`"/loans/legal"` → own ? `"Your defaulted loans going to court: fill in the contract details Legal asks for."` : `"Defaulted loans going to court: the case sheet to send, the attorney’s fee, and what’s come back."`),
  loan detail page (`[id]/sections.tsx` or `loan-panels.tsx`): a "Legal case" link on defaulted/written-off loans, and
  fee per day + Unsecured inputs in the Collateral panel.

List page: `ViewTabs` Needs details / Ready / With Legal / Closed (default: everything not Closed), `ListSearch`,
columns Borrower (name + State ID), Officer, Defaulted, Claim (preview or frozen total), State badge, Fee (With Legal
only: Paid / Not paid). Case page: the sheet in a `CopyBlock` (frozen text when handed over, else the live preview
labelled "Preview — counted to today"), a Missing list with **Ask the officer**, the contract-details form (fee per
day, unsecured, contract shared), default-date correction (when `canHandToLegal`, before hand-over), **Hand to Legal**
dialog (payee select of Legal staff, default the only one; reason field when handing over again), the fee panel
(`Fee to pay: $2,750`, comment, `PhoneHelper` with `phoneList([{ name, stateId, owedCents, comment }])`, paid rows,
suggestions with **This is the fee**), the money picture (Claim · Fee paid · Recovered · Net for Litt’s · Still owed),
and **Close case** (management+, note required). All actions via `withStepUp`-free `runAction` (none are sensitive).

- [ ] **Step 1:** Implement pages, actions (Zod schemas from Task 3), nav and tour line.
- [ ] **Step 2:** `pnpm lint && pnpm typecheck && pnpm test` → PASS (the tour test fails without the `describe()` line).
- [ ] **Step 3:** `pnpm build && pnpm start`, check both pages by hand in Chrome as CEO and as an officer.
- [ ] **Step 4:** Commit `Legal cases: pages`.

### Task 7: Keep the lawyer out of officer and pool lists

**Files:** Modify `src/server/loans/queries.ts` (`activeStaffOptions`: exclude role `legal`),
`src/server/commissions/service.ts` (roster: a `legal` staff member is never `suggested`); tests in
`tests/integration/staff.test.ts` / `commissions.test.ts`.

- [ ] **Step 1:** Failing tests: `a Legal Team member is not an officer option`; `a Legal Team member with app activity
  is not suggested for the pool`.
- [ ] **Step 2–4:** Run → FAIL, implement, run → PASS.
- [ ] **Step 5:** Commit `Lawyer's login: not an officer option or a pool suggestion`.

### Task 8: Browser test and docs

**Files:** Create `tests/e2e/legal-cases.spec.ts`, `docs/research/21-legal-cases.md`; Modify `docs/design/LOANS.md`,
`docs/SPEC.md` (scope line: case *preparation* is in scope; court tracking stays in game), `docs/CHANGELOG.md`, `CLAUDE.md`
(status line, a key domain fact for the hand-moved default date and the fee reference, read-first pointer).

- [ ] **Step 1:** e2e (fixtures have defaulted loans): as CEO, open Legal cases → a Needs-details case → enter fee per day
  and Unsecured → Ready → Hand to Legal to a Legal user → sheet frozen, copy button copies the text, fee panel shows
  $2,750 and the `#LC` comment; axe passes on both pages (with `best-practice`).
- [ ] **Step 2:** `pnpm build && pnpm start` (free :3000 first), `pnpm test:e2e tests/e2e/legal-cases.spec.ts` → PASS;
  then the full `pnpm test:e2e` and `pnpm check`.
- [ ] **Step 3:** Write the docs (research/21 records every owner answer from the spec, dated 2026-11-10).
- [ ] **Step 4:** Commit `Legal cases: browser test and docs`. Don't push — the owner decides.

## After deploy (owner)

Invite the lawyer: `pnpm staff:invite:prod --state-id <their State ID> --name "<name>" --role legal`. Then for the eight
cases (25718, 15819, 4457, 14962, 13325, 2932, 9115, 20511) press **Ask the officer**; paste the Default tab first so
Tatum Bramley (20511) appears. Verify read-only that each sheet's figures match the table in the spec.
