# Design system

Last revised by the October 2026 redesign (`REDESIGN-2026-10.md`), the UX pass of 11 October (`UX-PASS-2026-10-11.md`)
and the UX review of 12 October (`UX-REVIEW-2026-10-12.md`).

## Principles

1. **Clarity over decoration.** Dense, calm screens; colour carries meaning, not mood.
2. **Exceptions first.** Worklists and warnings lead; healthy states recede.
3. **Traceable numbers.** Every figure links back to the rows it came from.
4. **Accessible by default.** WCAG 2.2 AA; keyboard-complete; status never by colour alone.
   Checked with axe-core on every page in both themes.
5. **Always say what's happening.** Every page has a loading state and an error state.

## Brand

Sampled from `reference/brand/litts-loans-logo.png`.

| Token | Hex | Use |
|---|---|---|
| Brand green | `#59B280` | Dark-mode primary; sidebar accent; decorative in light mode (2.6:1 on white — never text) |
| Primary (light) | `#2E7752` | Light-mode text/actions (5.4:1 on white) |
| Money teal | `#75ACA8` | Info accents, second chart series |
| Cream | `#F2F0E2` | Brand surfaces |
| Charcoal | `#232624` | **Sidebar (both themes, darker in dark mode)**, auth brand panel |
| Ink | `#1B1D1B` | Light-mode text |

Wordmark: "Litt's" Barlow Condensed Light Italic + "LOANS" Barlow Condensed ExtraBold
Italic. `Wordmark inverse` for dark surfaces (sidebar). The character portrait in the logo
is not used in the product UI.

## Tokens

All colours are CSS variables in `src/app/globals.css` (OKLCH), with contrast ratios noted
inline. Semantic status tokens: `success`, `warning`, `danger`, `info`, `neutral`, each with
a `-subtle` background. Sidebar tokens include `sidebar-muted-foreground`.

## Typography

| Use | Class | Size |
|---|---|---|
| Page title | `.text-title` | 22/28 semibold |
| Card / section title | `CardTitle` | 15 semibold |
| Body, table cells | — | 14 |
| Table headers, notes | `text-xs` / `.text-caption` | 12, muted |
| Figures in strips | (built into `Kpi`) | 20 semibold, tabular |

- **Inter** for UI. All money and counts use `.num` (tabular, lining figures).
- **JetBrains Mono** via `.ident` for identifiers (State IDs, wallets, references).
- Barlow Condensed for the wordmark only.

## Layout and shell

- **Sidebar** (charcoal): ten places — Dashboard, Collections · Loans, Mortgages, Borrowers
  · Finance, Commissions · Staff, Settings, Audit log. The current page has a brand-green
  bar and highlight. Account, security, theme and sign-out live in the user menu.
- **Top bar** (`PageHeader`): sidebar toggle, breadcrumbs *only when there's a parent*,
  **search** (`Ctrl/⌘K`, `SearchPalette`), the bell, and **New** (`AddDataMenu`, an *outline* button:
  "Start a deal" — new loan, new quote; "Bring in data" — paste phone cards, paste from tablet,
  import bank export — by permission).
- **Title block**: title, optional `meta` (status badges beside the title), description,
  actions (outline, plus at most **one filled primary** — the page's main action, e.g. New loan;
  the top bar has none), optional `tabs`.
- **Section tabs** (`SectionTabs`, `FinanceTabs`): a section's own pages (Finance:
  Overview, Transactions, Ledger, Reports, State allowance, Imports).
- **View tabs** (`ViewTabs`, `components/data`): a list's status/view filter as links, with counts
  (`tone: "attention"` turns a non-zero count red). Never hand-roll a tab bar — three copies once
  lacked a focus ring.
- `NavigationProgress` (thin top bar while a page loads — no route `loading.tsx`, so pages
  keep real 404/403 statuses), `error.tsx` (retry + way out, `retry` prop in Next 16),
  `not-found.tsx` — all inside the app frame. Skip links: "Skip to content" and, on list
  pages (`#results`), "Skip to the list".

## Components

shadcn/ui on **Base UI** primitives (`render` prop, not `asChild`). App-level:

- `StatStrip` + `Kpi` — headline figures on one surface divided by hairlines; 2 columns on
  phones (an odd last figure spans both), `cols` from `lg`. `Kpi` takes `tone`
  (`warn`/`bad` → coloured dot), `hint` (keep to a few words) and `href` (whole cell links).
- `Alert` variants `warning` / `danger` / `info` / `success` — tinted banners; icon carries
  the tone, text stays ink. Static banners have no live-region role.
- Tables: compact (`px-3 py-2`), muted 12 px header on a tinted band, row hover.
  `RowLink` + `linkedRow` make the whole row clickable with one tab stop.
  `SortHeader` for sortable columns (`aria-sort`). Wide tables pass `scrollLabel` so the
  scroll area is named and keyboard-scrollable.
- Charts (`components/data/charts.tsx`): `StackedBarChart`, `AreaChart` — server-rendered
  SVG, theme colours, `role="img"` with a written summary and a *Show as table* disclosure.
  No chart library (nothing for the CSP to allow, no client JS).
- `StatusBadge` — tone + dot + text label. `LocalTime` — UTC stored, local shown, UTC on hover.
- `CopyValue` — a value with a copy button (pay sheet, phone/tablet checklists).
- `CopyBlock` — a long text shown as it will be pasted, one copy button (loan contracts).
- `AppTour` (`app-shell`) — the role-aware first-visit tour (`TUTORIAL-2026-10-12.md`): content in
  `tour-steps.ts`, anchored to `data-tour` attributes; "Take the tour" in the account menu.
- `LongText` — free text (notes, collection logs): past 400 characters shows the start and
  "Show the whole note" (native `<details>`).
- `Button` with `render={<Link …/>}` renders the link itself with button styles (stays a link for
  screen readers); a `disabled` one renders as inert text.
- `Fact` — one label/value row in a details card's `<dl>` (loan and mortgage pages).
- `MatchControls` — "Not this loan/mortgage" / "Link a loan/mortgage…" for offers and quotes:
  dialog with a required reason (audit log); the officer or management only.
- `WhoToggle` — "Everyone / Mine" switch for team lists (offers, quotes).
- `AffixInput` (`components/forms`) — number field with its unit inside ("$", "%", "weeks"); money
  shows thousands separators when not editing; text input, digits only.
- `ListSearch` — list search that filters as you type (250 ms), keeps other parameters, and is
  what `/` focuses (`data-list-search`).
- `.sticky-col` — pins the first column of a wide table that scrolls sideways (P&L).
- `KeyboardShortcuts` — `?` help, `/` list search, `G`+letter go to, `N`+letter start; off switch
  (localStorage `litts.shortcuts`); open the list with the `litts:shortcuts` window event.
- `NotificationBell` (top bar) — Base UI Popover with a list of links; red count of unread;
  opening refetches; the list is computed, only "read" is stored.
- `ExportButton` + `exportHref` — "Excel" on list pages, carrying the page's filters.
- `DataAsOf` — caption at the foot of list pages: bank export / phone cards / tablet age.
- `RecentlyViewed` — renders nothing; records a detail page for the search palette's
  *Recently viewed* group (localStorage per staff member, guarded).
- `CollectionsPanel` (`components/data`) — collections log for a loan or a mortgage.
- Detail pages: status in the title `meta`, a `StatStrip` of the key figures first, then
  details; side-panel forms that are used occasionally open on demand (*Change*, *Add*).

## Patterns

- Text: every money, number, percentage and date string comes from `src/lib/format.ts`
  (`formatCents`, `formatDollars`, `formatCount`, `formatBp`, `dateFormat`) or `<Money>` /
  `<LocalTime>` — a lint rule rejects `toLocale*String` elsewhere.
- Detail pages: `page.tsx` loads the data (in parallel) and lays out the figures strip, warnings
  and side panels; the cards live in a sibling `sections.tsx` as plain server components.
- Landmarks: one `<main>` (the layout's `SidebarInset`), the sidebar is `<nav aria-label="Main">`,
  and "Skip to content" lands on the page title (`#main`). axe runs with best-practice rules too.

- Home: management+ land on the Dashboard; loan officers on **My work** (`dashboard.company`).
- Settings-style forms: one row per value with the unit beside it, ranges on one line,
  changed values highlighted with "Was …", a sticky save bar with a change count and Discard.
- Breadcrumbs only for pages with a real parent; never a section label that isn't a page.
- Dates: three-letter months ("Sep", never "Sept") — `shortMonths` / `dateFormat` in `lib/dates.ts`.

- Destructive actions: a dialog naming the person/thing, a consequence sentence, a
  required reason (audit log), destructive-styled confirm; sensitive ones ask for a code.
- One-time secrets (invite links, backup codes): shown once, copy/download, "won't be shown again".
- Tables collapse secondary columns below `sm`/`md`/`lg`; key facts move under the primary cell.
- Times: relative for recency, absolute for records; exact UTC on hover.
- Empty states say why it's empty and what to do next.

### Writing (copy review, 2026-10-12: `docs/design/COPY-REVIEW-2026-10-12.md`)

- Say what the record or figure is and what to do; no slogans, greetings, "platform", "get started",
  "seamless", "you're all set", "Lost?", or reassurance that isn't a fact.
- No em dashes in UI sentences: use a full stop, colon, semicolon, comma or brackets. Separate a
  value from its note with " · ". Labels read "Area: detail" or "Thing (detail)".
- Exceptions: the contract templates (owner's text, word for word) and ledger memos already posted
  ("Broker fee — <address>"), which stay as they are so old and new entries read alike.
- Errors say what happened and what to check ("Unexpected server error. Check whether the change
  saved before trying again."), never "Something went wrong".
