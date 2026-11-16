# Redesign — October 2026

Owner brief (2026-10-10): scrutinise the app against established UI/UX standards, plan a
redesign, implement it. Owner choices: **refined & denser** visual direction (charcoal
sidebar, finance-software calm), **fewer navigation items + Ctrl/⌘K search**, **a few
charts**, **desktop first** (phone stays fully usable).

Standards used: Nielsen's 10 usability heuristics; WCAG 2.2 AA (contrast 1.4.3/1.4.11,
focus 2.4.7/2.4.11, target size 2.5.8, status messages 4.1.3); Hick's and Fitts's laws;
data-display guidance from IBM Carbon (data tables, density), GOV.UK Design System
(error/notification patterns, plain language) and dashboard practice (Few,
*Information Dashboard Design*: exceptions first, small multiples, no decoration).

## Audit — what works

- Colour tokens meet AA in both themes; status is never colour alone (dot + text).
- Plain-language copy, honest empty states, explicit consequences on destructive actions.
- Tabular figures, right-aligned money, identifiers in monospace.
- Step-up and reason patterns for sensitive actions are consistent.

## Audit — problems (by severity)

| # | Problem | Standard | Where |
|---|---|---|---|
| 1 | **No loading feedback.** No `loading.tsx` anywhere: clicking a link to a server-rendered page (Finance, Commissions take ~1 s) shows nothing until it arrives. No `error.tsx` either — a server error shows the bare Next.js page. | Nielsen 1 (visibility of system status), 9 (recover from errors) | All pages |
| 2 | **Navigation overload.** 20 sidebar items in 5 groups; places (Loans) mixed with actions (Paste phone cards, Paste tablet, Imports). No way to jump to a borrower or loan from anywhere. | Hick's law; Nielsen 6 (recognition), 7 (flexibility/accelerators) | Sidebar |
| 3 | **Low density / content below the fold.** Every figure is its own large card; Loans shows 6 KPI cards (2 rows) before the table, which starts ~650 px down on a 900 px screen. Table rows are ~54 px. On a phone the KPI cards stack one per screen-width. | Carbon density; Few (data-ink) | Loans, Mortgages, Finance, Commissions, Allowance |
| 4 | **Weak hierarchy ("card soup").** Everything is a white bordered card of equal weight, often cards inside cards; section titles look like card titles; the page has no focal point. | Gestalt (common region overuse); visual hierarchy | Everywhere |
| 5 | **Warnings look like content.** Important alerts ("payments on the wrong loan", "can't be paid yet", "mortgages not pasted") are white cards with a small icon. | Nielsen 1; GOV.UK notification banners | Loans, Mortgages, Catch-up |
| 6 | **Redundant header.** The sticky bar repeats the page title as the last breadcrumb directly above the H1; top-level pages get a 48 px bar that only says their own name. | Nielsen 8 (minimalist design) | All pages |
| 7 | **Tables.** Only the first cell is clickable (small target), no hover affordance, header scrolls away, no sorting, no row count. | Fitts's law; Carbon data table | Lists |
| 8 | **Detail pages bury the key numbers** in a definition list and keep several forms open in the right rail at all times (officer, collateral, notes, write-off, collections). | Progressive disclosure; Nielsen 8 | Loan, Mortgage |
| 9 | **Dashboard** has a ragged 3-of-4 KPI row, low-value Team/Security cards at equal weight with money, a large empty area under the to-do list, and no sense of trend. | Few (exceptions first, trends) | Dashboard |
| 10 | **Brand is faint.** The logo's charcoal/cream/green appears only on the sign-in panel; the product shell is generic. | Aesthetic integrity | Shell |

## Plan

**1. Foundations**
- Tokens: charcoal sidebar in both themes (matching the sign-in panel); type scale
  (page title 22/28, section 15/22 semibold, table 13/20, caption 12/16); compact
  density by default; tinted surfaces for alerts.
- `loading.tsx` skeletons for every section and `error.tsx` with retry + support text;
  a not-found page in the app frame.

**2. Shell and navigation** (≈10 places)
- Sidebar: Dashboard · Collections · Loans · Mortgages · Borrowers · Finance ·
  Commissions · Staff · Settings · Audit log. Security and sign-out stay in the user menu.
- Finance sub-pages (Overview, Transactions, Ledger, Reports, Allowance, Imports) become
  a tab bar inside Finance.
- Paste phone cards / Paste tablet / Import bank export: an **Add data** menu in the top
  bar, and as primary buttons on Loans, Mortgages and Finance.
- **Ctrl/⌘K search**: borrowers (name or State ID), loans, properties, staff, pages and
  actions, from anywhere.
- Top bar: breadcrumbs only where there's a parent; search and Add data on the right.

**3. Components**
- `StatStrip`: one surface, metrics divided by rules (label, figure, short note, optional
  link); 2 columns on phones. Replaces KPI card grids.
- `Callout`: tinted warning / danger / info / success banners with title and actions.
- Tables: compact rows, sticky header, row hover, whole-row link (stretched primary link
  — one tab stop per row), sortable columns on Loans and Mortgages, row count.
- `DetailHeader`: title, status, key figures strip, primary actions.
- `Disclosure` panels for occasional forms (change officer, add collateral, add note).
- Charts: small server-rendered SVG (bar, line), role="img" with a text summary and a
  data table behind a disclosure — no extra library, no inline `<style>`, no client JS.

**4. Pages**
- Dashboard: attention list first; one metric strip; *Money in, next 8 weeks* bars;
  *Cash, last 90 days* line; Expected to receive compact; team/security demoted.
- Loans / Mortgages: metric strip + tab counts + sortable dense table; warnings as callouts.
- Loan / Mortgage detail: figures strip, schedule, payments; side forms behind disclosures.
- Finance: tab bar; cash chart; forecast; the rest restyled.
- Collections, Commissions, Catch-up, Settings, Staff, Audit: new components, denser tables.

**5. Verification**
- Automated accessibility scan (axe-core via Playwright) on every page, both themes.
- Before/after screenshots at 1440 px and 390 px, light and dark.
- Keyboard pass: skip link, search, menus, dialogs, tables.

## Outcome (2026-10-10)

Delivered: foundations (tokens, type scale, density, tinted banners), loading / error /
not-found states, charcoal 10-item sidebar, Finance tab bar, top bar with Ctrl/⌘K search
and Add data, `StatStrip` across list and detail pages, whole-row links and sortable
columns (Loans) with tab counts, loan and mortgage detail figure strips and on-demand side
forms, dashboard with *Needs attention*, *Money in, next 8 weeks* and *Cash, last 90 days*
charts.

Verification: axe-core (WCAG 2.0/2.1/2.2 A and AA) on 23 pages × light and dark plus the
open search palette — **no violations** (the first scans found three: avatar initials
contrast 4.28:1, two scroll areas without keyboard access, and the dark destructive button
at 4.45:1 — all fixed). 395 tests pass; no console errors.

Changed from the plan: sticky table headers were dropped — tables sit in horizontally
scrolling containers, where a sticky header can't follow the page scroll; the compact
header band and row counts carry the orientation instead. The mortgage officer panel keeps
its open form when nobody is assigned (that's the case where it's needed).
