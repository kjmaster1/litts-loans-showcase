## Code review — 11 October 2026

The owner asked for a harsh senior-developer review. Every point, and what became of it.

| # | Criticism | Outcome |
|---|---|---|
| 1 | Deploys by hand from a laptop (`vercel deploy` uploads uncommitted files); migrations with prod credentials from a dev machine; no gate | **Fixed.** GitHub Actions: checks → migrate → deploy → smoke check, on push to `main` only; kill switch `DEPLOY_FROM_CI` (`docs/operations/DEPLOYING.md`). |
| 2 | "Verified in Chrome" wasn't reproducible: browser scripts lived in a temp folder | **Fixed.** `tests/e2e` (crawl per role, odd URLs, accessibility incl. best practice, flows), seeded through the UI, nightly in CI. |
| 3 | Pages wrote to the database on GET (payout matching, mortgage sync) | **Fixed.** Writes sync themselves (import, pastes, reclassify); `mortgageSyncPending()` is a read-only check asserted by a test and the daily health check. |
| 4 | Every request recomputes everything | **Withdrawn after measuring:** ~8 loans and 10–40 mortgages a month, 16 MB of 512 MB, at most 4 users at once — fine for years. |
| 5 | Automatic matching (offer → loan, quote → mortgage) with no undo | **Fixed.** Unlink ("not this one", remembered) and link by hand; audited (migration 0021). |
| 6 | Money maths with decimal rates and a floating-point fudge | **Fixed where the rule is ours:** `percentOfCents` (integer basis points) for quotes, offers and commission shares — e.g. 4.35% of $1,000 now gives $44, not $43. **Kept on purpose** for the State levy and loan analysis, which mirror the game's own floating-point arithmetic (changing them would re-post levy corrections). |
| 7 | Access rules scattered; a `null` viewer + `{ everyone: true }` bypass | **Fixed.** `src/server/authz/rules.ts` holds every record-level rule; aggregates pass the explicit `SERVER_AGGREGATE` marker; a test pins the rules per role. |
| 8 | Fat pages; formatting copy-pasted (a missing "$", "Sept", "09/10/2026") | **Fixed.** `src/lib/format.ts`; lint forbids `toLocaleString`/`toLocaleDateString`/`toLocaleTimeString` elsewhere; loan page 552 → 200 lines, mortgage page 470 → 148 (`sections.tsx`). |
| 9 | Audit chain key sits beside the database: whoever has both can re-sign history | **Fixed.** Nightly anchor of the newest audit entry's hash on the `audit-anchors` branch; the daily health check confirms recent anchors still match. |
| 10 | No alerts | **Fixed.** Email via GitHub: CI/deploy, backup, browser tests, daily health (server errors via `app_error`, stale data, stale backups, anchors, sync gaps), monthly restore drill. |
| 11 | Knowledge in prose | Ongoing: rules moved into code and tests where they're enforceable (rules matrix, audit labels, lint). |
| 12 | Free tiers | Measured; monitored by the health check (backups, data age). Owner prefers zero cost. |

Found by the new checks along the way: NUL bytes and overlong numbers crashing searches;
a hydration error; the audit page's page marker overflowing; a rate-limited 2FA enrolment
saying "code didn't match"; the only backup predating the Settings table; two "dd/mm/yyyy"
dates; a missing "$". All fixed.
