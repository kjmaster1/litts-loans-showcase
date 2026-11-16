// Daily health check of the live database (.github/workflows/health.yml). Read-only.
// Fails — so GitHub emails the owner — when the app has recorded server errors since the
// last run, or the data is getting stale. Usage: DATABASE_URL=… node scripts/ops/health-check.mjs
import { appendFileSync } from "node:fs";
import pg from "pg";

const HOURS = Number(process.env.HEALTH_WINDOW_HOURS ?? 26); // daily run, with overlap
const BANK_MAX_DAYS = 8; // the bank export is imported about weekly
const CARDS_MAX_DAYS = 8; // the phone cards are pasted weekly

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(2);
}
const parsed = new URL(url);
if (parsed.searchParams.get("sslmode") === "require") parsed.searchParams.set("sslmode", "verify-full");
const db = new pg.Client({ connectionString: parsed.toString() });
await db.connect();

const problems = [];
const lines = [];
const days = (d) => (d ? (Date.now() - new Date(d).getTime()) / 86_400_000 : Infinity);
const ago = (d) => (d ? `${Math.max(0, days(d)).toFixed(1)} days ago` : "never");

const errors = await db.query(
  `select coalesce(route, '(no route)') as route, source, count(*)::int as n, max(occurred_at) as last, min(message) as example
     from app_error where occurred_at > now() - make_interval(hours => $1) group by 1, 2 order by n desc`,
  [HOURS],
);
if (errors.rows.length) {
  const total = errors.rows.reduce((s, r) => s + r.n, 0);
  problems.push(`${total} server error${total === 1 ? "" : "s"} in the last ${HOURS} hours`);
  for (const r of errors.rows) lines.push(`- ${r.n}× ${r.source} ${r.route} — ${r.example.slice(0, 160)}`);
}

const { rows: [bank] } = await db.query(`select max(created_at) as at, max(last_tx_at) as last_tx from import_batch`);
lines.push(`Bank export last imported ${ago(bank.at)} (newest row ${ago(bank.last_tx)})`);
if (days(bank.at) > BANK_MAX_DAYS) problems.push(`No bank export imported for ${days(bank.at) === Infinity ? "ever" : `${Math.floor(days(bank.at))} days`} (limit ${BANK_MAX_DAYS})`);

const { rows: [cards] } = await db.query(`select max(captured_at) as at from loan_paste`);
lines.push(`Phone cards last pasted ${ago(cards.at)}`);
if (days(cards.at) > CARDS_MAX_DAYS) problems.push(`Phone cards not pasted for ${days(cards.at) === Infinity ? "ever" : `${Math.floor(days(cards.at))} days`} (limit ${CARDS_MAX_DAYS})`);

// Every write that brings in mortgage money syncs mortgages itself (pages no longer do it on
// load), so anything left unreflected means a code path forgot — see mortgageSyncPending().
const { rows: [gap] } = await db.query(`
  select (select count(*) from bank_transaction b where b.category = 'mortgage.origination_in'
            and not exists (select 1 from mortgage m where m.origination_tx_id = b.id))::int as originations,
         (select count(*) from bank_transaction b
            join mortgage m on m.merged_into_id is null and lower(trim(split_part(b.comment, ':', 1))) in (
              select lower(trim(a)) from unnest(array_append(m.address_aliases, m.address)) a)
           where b.category = 'mortgage.repayment_in'
             and not exists (select 1 from mortgage_payment p where p.bank_transaction_id = b.id))::int as repayments`);
if (gap.originations || gap.repayments) {
  problems.push(`Mortgage data is behind the bank: ${gap.originations} origination(s) without a mortgage, ${gap.repayments} repayment(s) not linked (a sync didn't run)`);
}

// Pasted records the bank should have confirmed by now (src/server/data-quality.ts — same rule):
// created over a day before the newest imported bank row, still with no bank money. Most likely a
// duplicate or a mistyped paste (a stray tablet heading once became a mortgage, 2026-10-12).
const { rows: unconfirmed } = await db.query(`
  with bank as (select max(last_tx_at) as newest from import_batch)
  select 'Mortgage "' || m.address || '" (' || coalesce(m.buyer_name, 'unknown buyer') || ')' as what, m.created_at
    from mortgage m, bank
   where m.merged_into_id is null and m.origination_tx_id is null and m.last_tablet_at is not null
     and m.created_at < bank.newest - interval '24 hours'
  union all
  select 'Card-only loan of $' || (l.principal_cents / 100) || ' (' || coalesce(l.borrower_name, 'State ID ' || l.borrower_state_id) || ')', l.created_at
    from loan l, bank
   where l.disbursement_tx_id is null and l.retired_at is null and l.created_at < bank.newest - interval '24 hours'
   order by created_at`);
if (unconfirmed.length) {
  problems.push(`${unconfirmed.length} pasted record${unconfirmed.length === 1 ? " is" : "s are"} not confirmed by the bank data — duplicate or typo? Merge or remove it on its page`);
  for (const r of unconfirmed) lines.push(`- ${r.what}, added ${ago(r.created_at)}`);
}

const { rows: [unpasted] } = await db.query(
  `select count(*)::int as n from mortgage where merged_into_id is null and status = 'active' and loan_cents is null and originated_at < now() - interval '3 days'`,
);
lines.push(`Mortgages waiting for their tablet details over 3 days: ${unpasted.n}`);

await db.end();

const summary = [`## Litt's Loans health — ${problems.length ? "needs attention" : "all good"}`, "", ...problems.map((p) => `**${p}**`), "", ...lines].join("\n");
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
process.exit(problems.length ? 1 : 0);
