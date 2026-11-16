# ADR 0004: Bank export times are UTC, whatever the header says

Date: 2026-10-13. Status: accepted (owner). Supersedes the "UTC-5" part of ADR 0001 row 4.

## Context

The in-game bank's `.xlsx` export has a header cell `TIMEZONE: UTC-5`. The import believed it and added 5 hours
to every row. The owner noticed the Transactions page showing times "in US time":

- The game's bank app showed a $802 commission payment at **09:54:41 (GMT+1)**, which is 08:54:41 UTC. The app
  showed **14:54** (UK time), so it had stored 13:54:41 UTC. The file must have said 08:54:41.
- Four of the six live imports had a "newest row" *after* the moment the file was imported (by up to 5 hours).
  The 9 October sample's newest row says 11:33; the owner saved the file at 11:55 UTC.
- Two people export (the owner in the UK, Zion Pemberton in the US). Every file is labelled `UTC-5`, and Zion's
  rows matched the owner's to the second (263 of 277, 131 of 134 and 12 of 14 rows already present), so the
  times don't depend on who exports. No payment was stored twice.

With 5 hours taken off, every import's newest row is minutes to hours before the import, and the $802 row is
at the game's time.

## Decision

1. The parser reads export times as UTC. The `TIMEZONE` label is still required and recorded on the import
   batch, but not used.
2. Migration `0024_bank_times_utc` moves every stored bank time 5 hours earlier, and every time copied from one:
   ledger entry dates (`journal_entry.effective_at`), loan start/finish (`opened_at`, `completed_at`), default
   dates estimated from bank times (a whole number of days after one), mortgage start (`originated_at`),
   offer `funded_at` and the import batch ranges. It matches copies to the second against the bank time, so the
   app's own times (week closes, write-offs, "now") are left alone. Card times (GMT+1 on the card) were already
   right and are not touched. Staged import previews are discarded.
3. **Fingerprints don't change.** A row's fingerprint hashes its time + 5 hours (`FINGERPRINT_CLOCK_SHIFT_MS`),
   which is what every stored row was hashed with, so re-importing an overlapping export still recognises it.
4. The ledger and raw bank rows are append-only by trigger. This is the one correction made by editing them:
   no amount, account, link or category changes, only the date each happened. The migration lifts the two
   triggers inside its own transaction and puts them back; it refuses to run (and the deploy stops) if loan
   interest would move uncounted into a closed commission period, or a commission payout would move to before
   the scheme start, and checks afterwards that no export holds a row from after its import.

## Consequences

- Times read correctly everywhere; about a fifth of rows (evening UK time) move back to the right day, week or
  month in reports, commission weeks and the forecast.
- Not changed: audit details that quote old times, and allowance readings (typed in by people, not copied from
  the bank). A reading meant to sit just before or after a mortgage should be checked against the mortgage's
  corrected start.
- Missed at first, found by the QA of 2026-10-13: a loan's "disbursed" and a mortgage's "originated" history events
  are dated with the bank row's time too (85 + 29 in production). Migration `0026_event_times_utc` moves them the
  same way (the event tables are append-only, so it lifts their triggers inside its transaction). The final check in
  0024 was later narrowed to exports holding rows from before their import, so a development database with a made-up
  future-dated test export can migrate (production had already passed it).
- `tests/integration/bank-times.test.ts` rebuilds the old state and runs the migration on it.
