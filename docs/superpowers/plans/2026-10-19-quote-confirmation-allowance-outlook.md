# Confirmed Quotes and the State Allowance Outlook — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mortgage quotes become Draft → Confirmed (with an expected signing time, and a "Signed in game" mark), and the
Quotes page projects the State allowance forward so each quote shows whether it fits on its signing day.

**Architecture:** One pure projection module (`src/domain/mortgages/allowance-outlook.ts`) does all the maths from plain
inputs and `now`. A server loader (`src/server/mortgages/allowance-outlook.ts`) gathers readings, bank events, mortgages,
quotes and settings, calls it, and filters mortgage names by `canSeeMortgage`. Pages render the result: a server-SVG step
chart on the Quotes page, an "Allowance on signing day" panel and a Confirm dialog on the quote page.

**Tech Stack:** Next.js 16.4 App Router (Server Components + Server Actions), TypeScript, Drizzle + Postgres 18, Zod,
Vitest (unit + integration), Playwright (e2e + axe), shadcn/Base UI components already in `src/components/ui`.

**Spec:** `docs/research/19-quote-confirmation-and-allowance-outlook.md` (read it first; this plan argues from it).
Mockup (option A): `docs/research/19-mockup.html`.

## Global Constraints

- Follow `CLAUDE.md` throughout: every mutation writes `recordAudit(tx, …)` in the same transaction; every audit action
  needs a label in `src/lib/audit-labels.ts`; Server Actions use `authorize(cap)` inside `runAction()` and validate with
  Zod; record-level rules live only in `src/server/authz/rules.ts`; text formatting only via `src/lib/format.ts`;
  every client `<form>` has `method="post"`; inside a transaction run queries one after another (no `Promise.all`).
- Money is whole dollars in cents; derived amounts go through `wholeDollars()` (`src/lib/money.ts`).
- Statuses: `draft`, `confirmed`, `matched`, `cancelled`. Labels: Draft (neutral), Confirmed (info), Became a mortgage
  (success), Cancelled (neutral). "Open" disappears from the UI.
- The rule is read, never hard-coded: adopted rule, else conclusive best fit, else **no rule** (no repayments projected;
  originations and signings −1× loan).
- Cushion setting `mortgages.allowanceCushionDollars`, default **100,000**. Verdicts: **Short** = after < 0,
  **Tight** = 0 ≤ after < cushion, **Fits** otherwise.
- Horizon: 14 days from now, or the latest signing time (confirmed or draft) if later. "Fits from" searches up to
  **60 days** after the draft's signing time.
- Signing-passed and awaiting-tablet bell items fire **1 hour** after the time. Bank data is "old" when `bankTo` is
  more than **2 days** before now.
- Warnings never block: confirming is allowed when Short; executive approval is not needed to confirm.
- Copy uses ’ (curly apostrophe) in app strings; follow `docs/design/COPY-REVIEW-2026-10-12.md`.
- No new dependencies. Charts are server-rendered SVG like `src/components/data/charts.tsx`, colours from theme tokens.
- Commits: one per task, message ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Don't push;
  the owner says when.

## Review Focus

1. **Bank data older than the reading, or newer** — a repayment must be counted exactly once (bank event, inside the
   reading, or expected). Pinned in Task 4 (`counts a repayment once whichever of reading and bank is newer`).
2. **Signed in game before the reading, not yet pasted** — the loan must not be subtracted twice; signed after the
   reading it must be subtracted. Pinned in Task 4 (`signed quote counts only if signed after the reading`).
3. **Signing time typed by a US user** (Zion exports in the US) — the datetime-local value is the browser's time and
   must be stored as the right UTC instant. Pinned in Task 9 (e2e context with `timezoneId: "America/New_York"`).
4. **Two confirmed quotes with the same signing time** — deterministic order (lower quote number first) so verdicts don't
   flicker between page loads. Pinned in Task 4 (`orders same-time signings by quote number`).
5. **Company-funded confirmed quote** — no drop, no repayments, no verdict, no knock-on, and its column says
   "Company-funded". Pinned in Task 4 (`ignores company-funded quotes`) and Task 6 (list cell).

---

## File Structure

| File | Responsibility |
|---|---|
| `drizzle/0033_quote_confirmation.sql` (+ `meta/` snapshot) | Enum rename `open`→`draft`, add `confirmed`, five new columns |
| `src/server/db/schema/origination.ts` | Enum + columns |
| `src/domain/origination/quote-status.ts` (new) | `LIVE_QUOTE_STATUSES`, `isLiveQuote()` — pure, client-safe |
| `src/server/origination/mortgage-quotes.ts` | Save rules, `confirmQuote`, `unconfirmQuote`, `markQuoteSigned`, matching window, unlink → draft, list filters |
| `src/domain/settings.ts`, `src/app/(app)/settings/settings-form.tsx` | Cushion setting |
| `src/domain/mortgages/allowance-outlook.ts` (+ `.test.ts`) | The projection (pure) |
| `src/server/mortgages/allowance.ts` | Extract `loadAllowanceData()`; `allowanceLeft()` delegates to the outlook |
| `src/server/mortgages/allowance-outlook.ts` (new) | `getAllowanceOutlook()`, `previewConfirm()` |
| `src/components/data/allowance-outlook-chart.tsx` (new) | Server SVG step chart |
| `src/app/(app)/mortgages/quotes/page.tsx`, `outlook-card.tsx` (new) | Outlook card, tabs, columns |
| `src/app/(app)/mortgages/quotes/[id]/page.tsx`, `confirm-dialog.tsx` (new), `quote-actions.tsx`, `actions.ts` | Confirm / back to draft / signed; signing-day panel |
| `src/app/(app)/mortgages/quotes/quote-page.tsx`, `quote-form.tsx` | Signing-time field, allowance hint, back-to-draft warning |
| `src/lib/dates.ts` | `toLocalInput()` moved here from `allowance-forms.tsx` |
| `src/server/notifications.ts`, `src/components/app-shell/notification-bell.tsx` | Three new bell kinds |
| `src/server/my-work.ts`, `src/app/(app)/my-work/page.tsx` | Live quotes with signing time |
| `tests/integration/quote-confirmation.test.ts` (new), `tests/e2e/flows.spec.ts` | Integration + e2e |
| Docs | `ORIGINATION.md`, `MORTGAGES.md`, `CHANGELOG.md`, `CLAUDE.md` |

---

### Task 1: Rename Open to Draft (behaviour unchanged)

**Files:**
- Modify: `src/server/db/schema/origination.ts:67-74`
- Create: `drizzle/0033_quote_confirmation.sql` (+ `drizzle/meta/0033_snapshot.json`, `_journal.json` via generate)
- Create: `src/domain/origination/quote-status.ts`
- Modify: every `"open"` that means a quote: `src/server/origination/mortgage-quotes.ts` (lines ~102, 154, 199, 239, 262, 297), `src/server/origination/quote-review.ts` (41, 61, 83), `src/server/mortgages/approval.ts:156`, `src/server/notifications.ts` (152, 191, 215), `src/server/my-work.ts:44`, `src/app/(app)/mortgages/quotes/page.tsx`, `quote-page.tsx:16`, `[id]/page.tsx` (48, 54, 55, 60, 92, 101, 128, 138, 195, 203, 207, 217, 256), `status.ts`
- Test: `tests/integration/quote-confirmation.test.ts` (new), existing `origination.test.ts`, `quote-review.test.ts`

**Interfaces:**
- Produces: enum `mortgage_quote_status` = `draft | confirmed | matched | cancelled`; columns `expectedSigningAt`, `confirmedAt`, `confirmedByStaffId`, `signedAt`, `signedByStaffId` (all nullable; staff ids reference `staff.id`).
- Produces: `LIVE_QUOTE_STATUSES: readonly ["draft", "confirmed"]`, `type LiveQuoteStatus`, `isLiveQuote(s: QuoteStatus): s is LiveQuoteStatus` in `src/domain/origination/quote-status.ts`.

- [ ] **Step 1: Write the failing test** — `tests/integration/quote-confirmation.test.ts`, same setup as `quote-review.test.ts` (mock `@/server/request`, `resetDb`, `makeViewer` for ceo 3454, management 70010, officers 70011/70012, the `small` quote fixture).

```ts
it("a new quote is a draft, and the review/cancel paths accept drafts", async () => {
  const id = await saveQuote(officer, small);
  expect(await quoteRow(id)).toMatchObject({ status: "draft", expectedSigningAt: null, confirmedAt: null, signedAt: null });
  await addQuoteNote(manager, { id, text: "Lower the broker rate" });
  await cancelQuote(officer, { id, reason: "Buyer walked" });
  expect(await quoteRow(id)).toMatchObject({ status: "cancelled" });
});
```

- [ ] **Step 2: Run it to see it fail** — `pnpm vitest run tests/integration/quote-confirmation.test.ts` → FAIL (`status` is `"open"`).

- [ ] **Step 3: Schema + migration.** Enum becomes `["draft", "confirmed", "matched", "cancelled"]`, default `"draft"`, add the five columns. Run `pnpm db:generate --name quote_confirmation`, then **replace the generated SQL** with this (drizzle-kit would recreate the type and lose data):

```sql
ALTER TYPE "public"."mortgage_quote_status" RENAME VALUE 'open' TO 'draft';--> statement-breakpoint
ALTER TYPE "public"."mortgage_quote_status" ADD VALUE 'confirmed' BEFORE 'matched';--> statement-breakpoint
ALTER TABLE "mortgage_quote" ALTER COLUMN "status" SET DEFAULT 'draft';--> statement-breakpoint
ALTER TABLE "mortgage_quote" ADD COLUMN "expected_signing_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mortgage_quote" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mortgage_quote" ADD COLUMN "confirmed_by_staff_id" uuid REFERENCES "staff"("id");--> statement-breakpoint
ALTER TABLE "mortgage_quote" ADD COLUMN "signed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mortgage_quote" ADD COLUMN "signed_by_staff_id" uuid REFERENCES "staff"("id");
```

Then `pnpm db:generate` again must print "No schema changes" (snapshot agrees with the hand-written SQL).

- [ ] **Step 4: Replace quote `"open"` everywhere** with `isLiveQuote(q.status)` / `inArray(mortgageQuote.status, [...LIVE_QUOTE_STATUSES])`. Exceptions: `unlinkQuote` sets `status: "draft"`; `listQuotes` filter accepts `status?: QuoteStatus | "live"`; the list page's `"open"` tab key becomes `"draft"` (label "Drafts") — tabs are finished in Task 6. `status.ts`: `QUOTE_STATUS` keyed by all four statuses with the labels/tones in Global Constraints.

- [ ] **Step 5: Run** `pnpm db:migrate` (local), then `pnpm vitest run tests/integration` and `pnpm typecheck` → all PASS (existing origination, quote-review, mortgages tests unchanged in meaning; fix any literal `"open"` assertion in them to `"draft"`).

- [ ] **Step 6: Commit** — `git add -A drizzle src tests && git commit -m "Quotes: Open becomes Draft; add Confirmed and signing columns"`

---

### Task 2: Confirm, back to draft, signed in game

**Files:**
- Modify: `src/server/origination/mortgage-quotes.ts`, `src/lib/audit-labels.ts`
- Test: `tests/integration/quote-confirmation.test.ts`

**Interfaces:**
- Consumes: Task 1 columns and `isLiveQuote`.
- Produces (all in `mortgage-quotes.ts`, each a transaction with `.for("update")`, `canActOnQuote` check, audit):
  - `quoteSchema` gains `expectedSigningAt: z.coerce.date().nullable().default(null)`.
  - `confirmQuoteSchema = z.object({ id: z.uuid(), expectedSigningAt: z.coerce.date() })`; `confirmQuote(viewer, raw): Promise<void>` — draft → confirmed; sets `expectedSigningAt`, `confirmedAt = now`, `confirmedByStaffId`; audit `mortgages.quote.confirmed` with `{ number, expectedSigningAt }`.
  - `unconfirmQuoteSchema = z.object({ id: z.uuid() })`; `unconfirmQuote(viewer, raw)` — confirmed → draft; clears `confirmedAt/By` and `signedAt/By`; keeps `expectedSigningAt`; audit `mortgages.quote.unconfirmed`.
  - `markSignedSchema = z.object({ id: z.uuid(), signedAt: z.coerce.date() })`; `markQuoteSigned(viewer, raw)` — confirmed only; `signedAt` not more than 5 min in the future; audit `mortgages.quote.signed` with `{ number, signedAt }`.
  - Errors (`LoanError`, exact text): `"Only a draft can be confirmed."`, `"Only a confirmed quote can go back to draft."`, `"Only a confirmed quote can be marked signed."`, `"The signing time can’t be in the past."`, `"That time is in the future."`.

- [ ] **Step 1: Write the failing tests** (in `quote-confirmation.test.ts`):

```ts
it("the officer or management confirms with a signing time; a colleague can't", async () => {
  const id = await saveQuote(officer, small);
  const at = new Date(Date.now() + 2 * DAY);
  await expect(confirmQuote(other, { id, expectedSigningAt: at })).rejects.toThrow(ForbiddenError);
  await expect(confirmQuote(officer, { id, expectedSigningAt: new Date(Date.now() - HOUR) })).rejects.toThrow("The signing time can’t be in the past.");
  await confirmQuote(officer, { id, expectedSigningAt: at });
  expect(await quoteRow(id)).toMatchObject({ status: "confirmed", expectedSigningAt: at, confirmedByStaffId: officer.staffId });
  expect(await auditFor("mortgages.quote.confirmed", id)).toHaveLength(1);
  await expect(confirmQuote(officer, { id, expectedSigningAt: at })).rejects.toThrow("Only a draft can be confirmed.");
});

it("changing the figures sends a confirmed quote back to draft; moving the signing time or notes doesn't", async () => {
  const id = await saveQuote(officer, small);
  await confirmQuote(officer, { id, expectedSigningAt: new Date(Date.now() + 2 * DAY) });
  await saveQuote(officer, { ...small, notes: "Bids extended", expectedSigningAt: new Date(Date.now() + 3 * DAY) }, id);
  expect((await quoteRow(id)).status).toBe("confirmed");
  await saveQuote(officer, { ...small, priceDollars: 520_000 }, id);
  expect(await quoteRow(id)).toMatchObject({ status: "draft", confirmedAt: null });
  expect((await auditFor("mortgages.quote.updated", id)).at(-1)?.metadata).toMatchObject({ confirmation: "cleared" });
});

it("a quote marked signed in game stays confirmed and signed when its figures change", async () => {
  const id = await saveQuote(officer, small);
  await confirmQuote(officer, { id, expectedSigningAt: new Date(Date.now() + 60_000) });
  await markQuoteSigned(manager, { id, signedAt: new Date() });
  await saveQuote(officer, { ...small, priceDollars: 510_000 }, id);
  expect(await quoteRow(id)).toMatchObject({ status: "confirmed", signedByStaffId: manager.staffId });
  await unconfirmQuote(officer, { id });
  expect(await quoteRow(id)).toMatchObject({ status: "draft", signedAt: null, confirmedAt: null });
});

it("unlinking a matched quote returns it to draft", async () => { /* reuse origination.test.ts's match fixture */ });

it("matches a quote whose signing is more than 30 days after it was made", async () => {
  // quote created now, expectedSigningAt now + 40 days, mortgage inserted with originatedAt now + 39 days, same buyer and loan
  // → after matchQuotes(tx): status "matched"
});
```

(`DAY`, `HOUR`, `auditFor(action, targetId)` are small helpers at the top of the file.)

- [ ] **Step 2: Run** `pnpm vitest run tests/integration/quote-confirmation.test.ts` → FAIL (functions not exported).

- [ ] **Step 3: Implement** the three functions and the `saveQuote` changes:
  - A changed `expectedSigningAt` must not be in the past (5-minute skew allowance), checked only when it changed.
  - On update of a `confirmed` quote with `signedAt === null` and `approvedTermsChanged(q, row)`: set `status: "draft"`, clear `confirmedAt/By`, audit metadata `confirmation: "cleared"`. Signed quotes keep their status.
  - `matchQuotes` window end = `max(createdAt + 30 days, expectedSigningAt + 30 days)`.
  - `src/lib/audit-labels.ts`: `"mortgages.quote.confirmed": "Confirmed a mortgage quote"`, `"mortgages.quote.unconfirmed": "Moved a mortgage quote back to draft"`, `"mortgages.quote.signed": "Marked a mortgage quote signed in game"`.

- [ ] **Step 4: Run** the file again, plus `pnpm vitest run src/lib` (audit-label scan) → PASS.

- [ ] **Step 5: Commit** — `"Quotes: confirm with a signing time, back to draft, signed in game"`

---

### Task 3: Cushion setting

**Files:** Modify `src/domain/settings.ts`, `src/app/(app)/settings/settings-form.tsx`; Test `src/domain/settings.test.ts` (or the existing settings unit test), `tests/integration/settings.test.ts` if it snapshots the shape.

**Interfaces:** Produces `Settings["mortgages"]["allowanceCushionDollars"]: number` (default `100_000`, validated by `dollars`), label `"mortgages.allowanceCushionDollars": "State allowance: cushion before a quote counts as Tight ($)"`.

- [ ] **Step 1: Failing test** — `expect(resolveSettings({}).mortgages.allowanceCushionDollars).toBe(100_000)` and an older stored version without the key resolves to 100,000.
- [ ] **Step 2: Run** `pnpm vitest run src/domain/settings` → FAIL.
- [ ] **Step 3: Implement** — schema field, default, `SETTING_LABELS` entry, a field in the settings form next to `executiveApprovalAboveDollars` (same component and copy style).
- [ ] **Step 4: Run** `pnpm vitest run src/domain/settings tests/integration/settings.test.ts` → PASS.
- [ ] **Step 5: Commit** — `"Settings: State allowance cushion"`

---

### Task 4: The projection (pure)

**Files:** Create `src/domain/mortgages/allowance-outlook.ts`, `src/domain/mortgages/allowance-outlook.test.ts`.

**Interfaces:**
- Consumes: `AllowanceRule`, `AllowanceEvent`, `effect()` from `src/domain/mortgages/allowance.ts`; `wholeDollars` from `src/lib/money.ts`.
- Produces:

```ts
export const NO_RULE: AllowanceRule; // { id: "none", label: "No allowance rule adopted", originationMultiple: 1, repaymentBasis: "principal", repaymentMultiple: 0 }

export type OutlookInstalment = { principalCents: number; totalCents: number };
export type OutlookMortgage = {
  id: string; label: string | null;          // null = viewer may not see it (server fills)
  status: "active" | "completed" | "defaulted";
  originatedAt: Date; instalments: OutlookInstalment[]; // from mortgageSchedule
  paidAt: Date[];                             // bank repayments, ascending
};
export type OutlookQuote = {
  id: string; number: number; address: string; officerStaffId: string;
  status: "draft" | "confirmed"; companyFunded: boolean;
  loanCents: number; instalments: OutlookInstalment[];   // from quoteMortgage's schedule
  expectedSigningAt: Date | null; confirmedAt: Date | null; signedAt: Date | null;
};
export type OutlookInput = {
  now: Date;
  reading: { at: Date; balanceCents: number };
  bankTo: Date | null;
  rule: AllowanceRule | null;
  knownEvents: AllowanceEvent[];               // bank-derived, as getAllowanceView builds them
  mortgages: OutlookMortgage[];               // State-funded only
  quotes: OutlookQuote[];                     // live quotes (draft + confirmed)
  cushionCents: number;
};
export type Verdict = "fits" | "tight" | "short";
export type OutlookStep = { at: Date; kind: "repayment" | "signing"; deltaCents: number; balanceCents: number; label: string | null; quoteNumber: number | null };
export type QuoteOutlook = {
  quoteId: string; number: number; signingAt: Date; passed: boolean;
  beforeCents: number; afterCents: number; verdict: Verdict;
  fitsFrom: Date | null;                      // drafts that are Short only; null = not within 60 days
};
export type AllowanceOutlook = {
  rule: AllowanceRule; ruleSource: "adopted" | "best_fit" | "none";
  readingAt: Date; bankTo: Date | null; bankStale: boolean;
  nowCents: number; horizon: Date; steps: OutlookStep[]; endCents: number;
  lowest: { at: Date; balanceCents: number; quoteNumber: number | null };
  behind: number;
  confirmed: QuoteOutlook[];                  // signing order
  drafts: QuoteOutlook[];                     // drafts with a signing time, each as a what-if on its own
};
export function projectOutlook(input: OutlookInput, ruleSource: AllowanceOutlook["ruleSource"]): AllowanceOutlook;
export type ConfirmPreview = {
  nowCents: number; repayments: { count: number; cents: number }; signings: { numbers: number[]; cents: number };
  quote: QuoteOutlook; knockOn: { quoteId: string; number: number; officerStaffId: string; shortByCents: number }[];
};
export function previewConfirmation(input: OutlookInput, quoteId: string, signingAt: Date): ConfirmPreview;
export function isBehind(m: OutlookMortgage, bankTo: Date | null): boolean;
```

The algorithm (from spec §2; the tests pin it):
- `anchor = max(reading.at, bankTo ?? reading.at)`. Rule `r = rule ?? NO_RULE`.
- Game due dates: instalment `k` (0-based, `k = paidAt.length` onwards) is due 7 days after `paidAt[k-1]`, or after `originatedAt` when `k = 0`; each later one 7 days after the previous.
- `isBehind`: the first unpaid instalment's due date is before `bankTo`.
- Expected repayments: `status === "active"`, not behind, due date `> anchor`; effect = `r.repaymentMultiple × (basis principal ? principalCents : totalCents)`; zero-effect repayments produce no step.
- Quote events: confirmed + not company-funded. Signed → origination at `signedAt`, counted only if `signedAt > reading.at`. Unsigned → origination at `max(expectedSigningAt, now)` with `passed = expectedSigningAt < now`. Each such quote's instalments follow weekly from its signing/signed time. Origination effect = `-r.originationMultiple × loanCents`.
- `nowCents = reading + Σ effect(known events after reading.at) + Σ expected repayments in (anchor, now] + Σ signed-quote originations in (reading.at, now]`.
- Steps from now to horizon, sorted by time, then signings before repayments at the same instant, then lower quote number.
- Verdict per confirmed quote uses the balance just before its own signing step.
- Draft what-if: insert the draft (and its instalments) at its `expectedSigningAt`; `fitsFrom` = the first candidate (the signing time itself, then the time of each later step with the draft placed just **after** that step, up to +60 days) at which the draft's after ≥ 0 **and** every later confirmed quote's after ≥ 0. Project repayments as far as the search needs, not just to the horizon.
- `previewConfirmation`: the same what-if for the given quote at `signingAt`; `knockOn` = confirmed quotes whose verdict is not Short without it and Short with it.

- [ ] **Step 1: Write the failing tests.** Shared fixture: rule `o1-principal4`; reading `{ at: 2026-10-12T06:00Z, balanceCents: $1,000,000 }`; `bankTo` 2026-10-12T00:00Z; `now` 2026-10-13T00:00Z; cushion $100,000; mortgage **M1** active, originated 2026-10-01T12:00Z, 4 instalments of principal $10,000 / total $11,000, paid 2026-10-08T13:00Z; confirmed quote **Q1** #1, loan $300,000, 3 instalments of $100,000 principal, signing 2026-10-14T20:00Z.

```ts
it("projects repayments and confirmed signings to the horizon", () => {
  const o = projectOutlook(base(), "adopted");
  expect(o.nowCents).toBe($(1_000_000));
  expect(o.steps.map((s) => [s.at.toISOString(), s.deltaCents, s.balanceCents])).toEqual([
    ["2026-10-14T20:00:00.000Z", -$(300_000), $(700_000)],
    ["2026-10-15T13:00:00.000Z", $(40_000), $(740_000)],
    ["2026-10-21T20:00:00.000Z", $(400_000), $(1_140_000)],
    ["2026-10-22T13:00:00.000Z", $(40_000), $(1_180_000)],
  ]);
  expect(o.horizon.toISOString()).toBe("2026-10-27T00:00:00.000Z");
  expect(o.lowest).toEqual({ at: new Date("2026-10-14T20:00:00Z"), balanceCents: $(700_000), quoteNumber: 1 });
  expect(o.confirmed[0]).toMatchObject({ number: 1, beforeCents: $(1_000_000), afterCents: $(700_000), verdict: "fits", passed: false });
});
it("leaves out a mortgage behind on payments, judged against the bank data", () => { /* M2 paid 2026-10-01, next due 10-08 < bankTo → isBehind true, behind = 1, no M2 steps */ });
it("counts a repayment once whichever of reading and bank is newer", () => {
  // (a) bankTo 2026-10-10T00Z, M3 paid 2026-10-04T00Z: due 10-11 is between bankTo and the reading → not counted; 10-18 counted.
  // (b) reading 2026-10-10T00Z, bankTo 2026-10-12T00Z, a known repayment event at 10-11 (principal $10,000) → nowCents += $40,000; M's next expected due is after 10-12 only.
  // (c) now 2026-10-16T00Z: M1's 10-15T13 instalment is in (anchor, now] → nowCents = $1,040,000 and no step for it.
});
it("signed quote counts only if signed after the reading", () => { /* signedAt 10-12T08 → nowCents −$300,000; signedAt 10-12T05 → no change */ });
it("treats a passed, unsigned signing as signing now", () => { /* expectedSigningAt 10-12T20 < now → signingAt = now, passed true */ });
it("orders same-time signings by quote number", () => { /* #2 and #3 at the same time; #2's before > #3's before */ });
it("projects no repayments without a rule", () => { /* rule null → ruleSource "none"; only signing steps; signings −1× loan */ });
it("ignores company-funded quotes", () => { /* confirmed company-funded quote: no step, not in confirmed[] */ });
it("grades Tight under the cushion and Short below zero", () => { /* loans $950,000 → tight (after $50,000); $1,050,000 → short */ });
it("shows a short draft's what-if and when it would fit", () => {
  // draft D #4, loan $900,000, signing 2026-10-14T22:00Z → drafts[0]: beforeCents $700,000, verdict "short",
  // fitsFrom 2026-10-21T20:00Z; confirmed[] unchanged; steps unchanged (drafts never move the line).
});
it("reports the confirmed quotes a confirmation would push short", () => {
  // previewConfirmation(input, E, 2026-10-14T10:00Z) for draft E loan $800,000:
  // quote.afterCents $200,000; knockOn = [{ number: 1, shortByCents: $(100_000) }]; signings.numbers = [] (none before 10-14T10)
});
it("whole dollars throughout", () => { /* a basis-gross rule with odd totals → every balanceCents % 100 === 0 */ });
```

- [ ] **Step 2: Run** `pnpm vitest run src/domain/mortgages/allowance-outlook.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** `allowance-outlook.ts`, with a top comment naming research/19 and the observed rule, in the style of `allowance.ts`.
- [ ] **Step 4: Run** the same command → PASS; `pnpm lint` clean.
- [ ] **Step 5: Commit** — `"Allowance outlook: project the State allowance to each signing"`

---

### Task 5: Server loader (privacy, freshness, one "now")

**Files:** Modify `src/server/mortgages/allowance.ts`; create `src/server/mortgages/allowance-outlook.ts`; modify `src/server/origination/mortgage-quotes.ts` (remove `quotePipeline`); Test `tests/integration/quote-confirmation.test.ts`.

**Interfaces:**
- Consumes: Task 4 `projectOutlook`, `previewConfirmation`; `dataFreshness()` (`src/server/freshness.ts`, `bankTo`); `canSeeMortgage` (`rules.ts`); `getSettings()`.
- Produces:
  - `loadAllowanceData(): Promise<{ readings; events: AllowanceEvent[]; mortgages: (typeof mortgage.$inferSelect)[]; payments: Map<string, MortgagePayment[]>; rule: AllowanceRule | null; ruleSource: "adopted" | "best_fit" | "none"; fit; adopted }>` in `allowance.ts` (the first half of today's `getAllowanceView`, which now calls it).
  - `getAllowanceOutlook(viewer: Viewer, now?: Date): Promise<AllowanceOutlook | null>` — `null` when there's no live reading. Requires `loans.originate`. Mortgage `label` = address only when `canSeeMortgage(viewer, m)`, else `null`.
  - `previewConfirm(viewer: Viewer, quoteId: string, signingAt: Date): Promise<ConfirmPreview | null>`.
  - `allowanceLeft()` keeps its type but returns `{ balanceCents: outlook.nowCents, source: ruleSource === "none" ? "reading" : "projected", readingAt }` so every page shows the same "now".

- [ ] **Step 1: Failing tests:**

```ts
it("the outlook hides other officers' mortgages from an officer but not from management", async () => {
  // insert a State-funded active mortgage owned by `other` with terms and one repayment, a reading, then:
  const mine = await getAllowanceOutlook(officer, now);
  expect(mine!.steps.filter((s) => s.kind === "repayment").every((s) => s.label === null)).toBe(true);
  const all = await getAllowanceOutlook(manager, now);
  expect(all!.steps.some((s) => s.label === "9 Test Row")).toBe(true);
});
it("confirmed quotes draw on the outlook; drafts don't", async () => { /* nowCents equal; confirmed adds a signing step; draft only in drafts[] */ });
it("returns null without a reading", async () => { /* resetDb-fresh state */ });
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Mortgage instalments come from `mortgageSchedule`; quote instalments from `quoteMortgage(inputOf(q))`'s loan/broker/federal split via `mortgageSchedule` with `originatedAt` = the signing time. Only `funding = "state"`, `mergedIntoId is null`, `originatedAt not null`.
- [ ] **Step 4: Run** `pnpm vitest run tests/integration` → PASS (existing allowance tests in `mortgages.test.ts` still pass).
- [ ] **Step 5: Commit** — `"Allowance outlook: server loader with mortgage privacy"`

---

### Task 6: Quotes page — outlook card, chart, tabs, columns

**Files:** Create `src/components/data/allowance-outlook-chart.tsx`, `src/app/(app)/mortgages/quotes/outlook-card.tsx`; modify `src/app/(app)/mortgages/quotes/page.tsx`; Test `tests/e2e/a11y.spec.ts` (already visits `/mortgages/quotes`), Task 9 e2e.

**Interfaces:**
- Consumes: `getAllowanceOutlook`, `AllowanceOutlook`, `QuoteOutlook`.
- Produces: `AllowanceOutlookChart({ outlook, summary }: { outlook: AllowanceOutlook; summary: string })` (server component, SVG like `charts.tsx`: `role="img"`, `aria-label`, theme-token classes, `<title>` per step for the hover text); `OutlookCard({ outlook, canSeeFinance })`.

- [ ] **Step 1: Chart.** Step line from `nowCents` through `steps`; zero line with a danger-tinted band below; "now" marker; signing points labelled `#N signs · −$X`; repayment points' `<title>`: `"{day time} · {label} payment +$X"` or, when `label` is null, consecutive hidden repayments within the same hour merged into `"{n} repayments · +$X"`. On the Drafts tab, each draft's what-if is a dashed drop at its signing time, plus a "fits from" marker when it's Short. Written summary for screen readers (lowest point, end balance, number of signings).
- [ ] **Step 2: Card.** Heading "State allowance — next 14 days" (or "— to {date}"); sub-line: rule label, "from the reading of {LocalTime}", "bank data to {LocalTime}", and "{n} mortgage(s) behind on payments left out" when > 0. When `bankStale`: "Bank data is {n} days old: repayments since then are estimated." When `ruleSource === "none"`: an info `Alert` (not `role="alert"`) "No allowance rule adopted, so repayments aren’t projected." with the Finance link only if `canSeeFinance` (`can(role, "finance.view")`). Three `Kpi`s: Allowance now; Lowest point ahead (tone `warning` if under the cushion, `bad` if negative, hint "{day time}, right after #N signs"); At {horizon date}. With no reading: today's empty state text "no reading recorded yet".
- [ ] **Step 3: Tabs and list.** Tabs **Drafts · Confirmed · Needs approval · Became a mortgage · Cancelled · All** with counts on the first three; keys `draft | confirmed | approval | matched | cancelled | all`; default = `confirmed` if any confirmed quote exists, else `draft`; an old `?status=open` link maps to `draft`. Columns: Quote · Buyer · Loan · **Signing (bids close)** (`LocalTime` + relative / "passed") · **Allowance at signing** (`Money` before, then "{$} left after" in the verdict tone; "If signed then" header on the Drafts tab; "Company-funded" for those; "—" without a signing time) · Officer · Status (status badge, then **Fits / Tight / Short** badge, "Signed, awaiting tablet" when `signedAt`, approval badges, change notes as today). Page description: "Every officer’s quotes not yet on the tablet. Confirmed quotes draw on the State allowance on their signing day; drafts show what would happen."
- [ ] **Step 4: Verify** `pnpm build && pnpm start` then `pnpm test:e2e tests/e2e/a11y.spec.ts` → PASS (axe incl. `best-practice`); look at the page in Chrome at 1280px and 390px wide (no horizontal page scroll; the table scrolls inside its card).
- [ ] **Step 5: Commit** — `"Quotes page: allowance outlook chart and signing columns"`

---

### Task 7: Quote page, Confirm dialog, form

**Files:** Create `src/app/(app)/mortgages/quotes/confirm-dialog.tsx`; modify `actions.ts`, `quote-actions.tsx`, `[id]/page.tsx`, `quote-page.tsx`, `quote-form.tsx`, `src/lib/dates.ts`, `src/app/(app)/finance/allowance/allowance-forms.tsx`.

**Interfaces:**
- Consumes: Task 2 `confirmQuote`, `unconfirmQuote`, `markQuoteSigned` (+ schemas); Task 5 `previewConfirm`, `getAllowanceOutlook`.
- Produces: actions `confirmQuoteAction`, `unconfirmQuoteAction`, `markQuoteSignedAction`, `previewConfirmAction(input: { id: string; expectedSigningAt: string }) → ActionResult<ConfirmPreview | null>` (all `authorize("loans.originate")`, `revalidatePath("/mortgages/quotes", "layout")`); `toLocalInput(ms: number): string` exported from `src/lib/dates.ts` (moved, allowance form imports it).

- [ ] **Step 1: Confirm dialog** (as mockup). Field "Expected signing: when the bidding closes" (`datetime-local`, prefilled from the quote's `expectedSigningAt` via `toLocalInput`, else empty; says "your time"). On change, debounce 300 ms and call `previewConfirmAction`; show the working rows: Allowance now · + {n} repayments due before then · − {n} confirmed signings before then (#numbers) · = Allowance just before signing · − this loan · = After signing. Then an `Alert` (role `alert` only after a change, per CLAUDE.md): Short → "Short by {$} on {date}. It would fit from about {date}. You can still confirm it." (or "It doesn’t fit within 60 days."); knock-on → "This fits, but #{n} ({address}, {date}) would then be short by {$}. It’s {officer}’s quote; they’ll be notified."; Tight → "It fits, with {$} left after." Button "Confirm", or "Confirm anyway" when there's a warning. Company-funded quotes: no working, just the time field and "Company-funded: it doesn’t use the State allowance." `<form method="post">`.
- [ ] **Step 2: Quote page.** Header actions for a live quote the viewer may act on: draft → **Confirm — buyer is going ahead** (opens the dialog), Edit, Cancel quote; confirmed → **Signed in game** (small dialog: time, default the expected signing time, max now), **Back to draft**, Edit, Cancel quote. A confirmed quote shows an info `Alert` "Confirmed by {name} · signing {LocalTime}" (or "Signed in game {LocalTime} · waiting for the tablet agreement"). Passed and unsigned → warning `Alert` "Signing time passed: did it sign?" with the three actions. **Allowance on signing day** card (State-funded live quotes with a signing time): the same working as the dialog (server-computed with `previewConfirm` for drafts, from the outlook for confirmed), verdict badge.
- [ ] **Step 3: Form.** New optional field "Expected signing (when the bidding closes)" (`datetime-local`, converted with `new Date(value).toISOString()` on submit, as the allowance form does). The allowance hint becomes: with a signing time, the projection's before/after at that time; without, "allowance now less confirmed signings" (`outlook.nowCents − Σ confirmed loans`). Replace the warning text with "The loan is more than the State allowance projected for its signing ({$})". For a confirmed, unsigned quote, an info line above Save: "Changing the figures moves it back to Draft. Confirm it again after saving."
- [ ] **Step 4: Verify** — `pnpm typecheck && pnpm lint`; run the app and, in Chrome, confirm a quote, move it back to draft, mark one signed; `pnpm test:e2e tests/e2e/a11y.spec.ts` → PASS.
- [ ] **Step 5: Commit** — `"Quote page: confirm with the allowance on signing day; signed in game"`

---

### Task 8: Bell and My work

**Files:** Modify `src/server/notifications.ts`, `src/components/app-shell/notification-bell.tsx`, `src/server/my-work.ts`, `src/app/(app)/my-work/page.tsx`; Test `tests/integration/quote-confirmation.test.ts`.

**Interfaces:**
- Consumes: Task 5 `getAllowanceOutlook` (computed once per `notificationsFor` call, only for `loans.originate` viewers).
- Produces: `Notification["kind"]` gains `"quote_signing_passed" | "quote_awaiting_tablet" | "quote_pushed_short"`; bell icons: `CalendarClock`, `Tablet`, `TriangleAlert` (lucide).

- [ ] **Step 1: Failing tests:**

```ts
it("asks the officer and management whether a passed signing happened", async () => {
  // confirmed quote with expectedSigningAt set in the past (direct db update) > 1 h ago, unsigned
  expect(await kinds(officer)).toContain(`quote_signing_passed:/mortgages/quotes/${id}`);
  expect(await kinds(manager)).toContain(`quote_signing_passed:/mortgages/quotes/${id}`);
  expect(await kinds(other)).not.toContain(`quote_signing_passed:/mortgages/quotes/${id}`);
  await markQuoteSigned(officer, { id, signedAt: new Date(Date.now() - 2 * HOUR) });
  expect(await kinds(officer)).not.toContain(`quote_signing_passed:/mortgages/quotes/${id}`);
  expect(await kinds(manager)).toContain(`quote_awaiting_tablet:/mortgages/quotes/${id}`);
});
it("tells an officer when a colleague's confirmation left their quote short", async () => {
  // reading $1,000,000; officer confirms A ($800,000, in 3 days); other confirms B ($500,000, in 2 days)
  expect(await kinds(officer)).toContain(`quote_pushed_short:/mortgages/quotes/${a}`);
});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Signing passed: officer of the quote, plus `loans.reassign_officer` holders; key `quote-signing:${id}:${expectedSigningAt.toISOString()}`; title "Did quote #{n} sign?", detail "{address}: the bidding closed {date}. Mark it signed, move the time, or cancel it." Awaiting tablet: officer + management; key `quote-tablet:${id}`; title "Paste the tablet agreement for quote #{n}". Pushed short: the officer of a confirmed quote whose verdict is Short when an earlier-signing confirmed quote was confirmed after theirs; key `quote-short:${id}:${other.confirmedAt.toISOString()}`; title "Quote #{n} no longer fits the allowance", detail "#{m} ({officer}) now signs first. Short by {$}." My work: quotes filter `isLiveQuote`, each row shows the status badge and the signing time.
- [ ] **Step 4: Run** `pnpm vitest run tests/integration` → PASS.
- [ ] **Step 5: Commit** — `"Bell: signing passed, awaiting tablet, pushed short"`

---

### Task 9: End-to-end, docs, finish

**Files:** Modify `tests/e2e/flows.spec.ts`, `docs/design/ORIGINATION.md`, `docs/design/MORTGAGES.md`, `docs/CHANGELOG.md`, `CLAUDE.md`.

- [ ] **Step 1: e2e spec** `test("a confirmed quote draws on the allowance on its signing day (research/19)")`: the management account records an allowance reading of $1,000,000 (Finance → Allowance) if the seed has none; the officer creates a $500,000 State-funded quote, opens Confirm, sets a signing time two days ahead, sees "Allowance just before signing", confirms; the Quotes page's Confirmed tab lists it with a Fits/Tight/Short badge and the chart's `aria-label` mentions "#{n} signs"; the officer edits the price → the quote shows Draft and "Confirm" again. Second context with `timezoneId: "America/New_York"`: confirm with `2026-11-02T18:00` typed → the quote page shows the same instant as `LocalTime` in UK time for a UK context (assert the stored ISO via the audit page or the time element's `dateTime` attribute = `2026-11-02T23:00:00.000Z`).
- [ ] **Step 2: Run** `pnpm build && pnpm start` (free port 3000 first, wait for "Ready"), then `pnpm test:e2e` → PASS (re-run a spec only on the Windows 0xC0000142 worker crash).
- [ ] **Step 3: Docs.** `ORIGINATION.md`: statuses table and the outlook (replace "Allowance pipeline"). `MORTGAGES.md` §State allowance: the observed rule (13/16 exact, the $1.3m top-up, credit lag) and that the owner adopted it 2026-10-19. `CHANGELOG.md`: one line. `CLAUDE.md`: Status line, "Read first" entry for research/19, key facts: quote statuses Draft/Confirmed (signed-in-game mark), the outlook lives in `domain/mortgages/allowance-outlook.ts` and counts each repayment once from `max(reading, bank end)`.
- [ ] **Step 4: Run** `pnpm check` → PASS.
- [ ] **Step 5: Commit** — `"Research 19: confirmed quotes and the allowance outlook — e2e and docs"`. Don't push; report to the owner. After they push and CI deploys, ask them to look at the Quotes page (the existing open quotes are now Drafts) and verify the "Allowance now" matches their next reading.
