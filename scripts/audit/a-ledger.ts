// AUDIT A — ledger integrity, cash, bank completeness. Read-only.
import { sql } from "drizzle-orm";
import { verifyAuditChain } from "@/server/audit/audit";
import { db } from "@/server/db";

const q = async <T extends Record<string, unknown>>(s: ReturnType<typeof sql>) => (await db.execute<T>(s)).rows;
const $ = (c: unknown) => `$${(Number(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const h = (t: string) => console.log(`\n## ${t}`);

h("A1 Trial balance & entry balance");
console.log(await q(sql`select sum(debit_cents) as dr, sum(credit_cents) as cr from journal_line`));
console.log("unbalanced entries:", await q(sql`select entry_id, sum(debit_cents) - sum(credit_cents) as diff from journal_line group by 1 having sum(debit_cents) <> sum(credit_cents)`));
console.log("entries with no lines:", await q(sql`select count(*) from journal_entry e where not exists (select 1 from journal_line l where l.entry_id = e.id)`));
console.log("lines on unknown accounts:", await q(sql`select count(*) from journal_line l where not exists (select 1 from ledger_account a where a.code = l.account_code)`));
console.log("fractional-cent lines (not whole dollars):", await q(sql`select account_code, count(*), sum(debit_cents - credit_cents) as net from journal_line where debit_cents % 100 <> 0 or credit_cents % 100 <> 0 group by 1`));
console.log("account nets not whole dollars:", await q(sql`select account_code, sum(debit_cents - credit_cents) as net from journal_line group by 1 having sum(debit_cents - credit_cents) % 100 <> 0`));

h("A2 Every bank row posted exactly once (active posting)");
console.log("rows without posting:", await q(sql`select count(*) from bank_transaction where posting_entry_id is null`));
console.log("posting entry not tied back to its row:", await q(sql`select count(*) from bank_transaction b join journal_entry e on e.id = b.posting_entry_id where e.bank_transaction_id is distinct from b.id`));
console.log("bank_posting entries per row (active+reversed):", await q(sql`
  select n, count(*) from (select b.id, count(e.id) filter (where e.kind = 'bank_posting') as n from bank_transaction b left join journal_entry e on e.bank_transaction_id = b.id group by b.id) x group by n order by n`));
console.log("reversals not pointing at a posting of the same row:", await q(sql`
  select count(*) from journal_entry r join journal_entry o on o.id = r.reverses_entry_id where r.kind = 'reversal' and r.bank_transaction_id is distinct from o.bank_transaction_id`));
console.log("non-active postings left unreversed:", await q(sql`
  select count(*) from journal_entry e join bank_transaction b on b.id = e.bank_transaction_id
   where e.kind = 'bank_posting' and e.id <> b.posting_entry_id and not exists (select 1 from journal_entry r where r.reverses_entry_id = e.id)`));

h("A3 Cash: books vs bank rows vs export header");
const [cash] = await q<{ books: string; recomputed: string }>(sql`
  select (select sum(debit_cents - credit_cents) from journal_line where account_code = '1000') as books,
         (select sum(case when direction = 'in' then amount_cents - tax_cents else -amount_cents end) from bank_transaction where category <> 'tax.remittance_record') as recomputed`);
console.log("books 1000:", $(cash.books), " recomputed from bank rows:", $(cash.recomputed));
const batches = await q<{ file_name: string; reported: string; last: Date; created: Date; rows: number; new: number; dup: number }>(sql`
  select file_name, reported_balance_cents as reported, last_tx_at as last, created_at as created, row_count as rows, new_count as new, duplicate_count as dup from import_batch order by created_at`);
for (const b of batches) {
  const [r] = await q<{ bal: string }>(sql`select sum(case when direction = 'in' then amount_cents - tax_cents else -amount_cents end) as bal from bank_transaction where category <> 'tax.remittance_record' and occurred_at <= ${b.last}`);
  console.log(`  export ${b.file_name} to ${String(b.last)}: header ${$(b.reported)} vs recomputed ${$(r.bal)} → diff ${$(Number(b.reported) - Number(r.bal))}  (rows ${b.rows}, new ${b.new}, dup ${b.dup})`);
}

h("A4 Bank row completeness / duplicates");
console.log(await q(sql`select count(*) as rows, min(occurred_at), max(occurred_at) from bank_transaction`));
console.log("same fingerprint, occurrence > 1 (identical rows kept as separate payments):", await q(sql`select count(*) from bank_transaction where occurrence > 1`));
console.log("biggest gaps between consecutive rows (days):", await q(sql`
  select prev::date as from_day, occurred_at::date as to_day, round(extract(epoch from occurred_at - prev) / 86400, 1) as days
    from (select occurred_at, lag(occurred_at) over (order by occurred_at) as prev from bank_transaction) x order by occurred_at - prev desc nulls last limit 5`));

h("A5 Tax withheld: rate per row, and vs monthly State 'Tax Payment' records");
console.log("in-rows by tax rate (tax/amount, 1 dp):", await q(sql`
  select tx_type, round(100.0 * tax_cents / nullif(amount_cents, 0), 1) as pct, count(*), sum(amount_cents)/100 as amount from bank_transaction
   where direction = 'in' group by 1, 2 order by 1, 2`));
console.log("tax% field vs computed (mismatch > 0.6pp):", await q(sql`
  select tx_type, tax_percent, amount_cents/100 as amt, tax_cents/100 as tax, round(100.0 * tax_cents / nullif(amount_cents,0), 2) as computed, left(comment, 60) as c
    from bank_transaction where direction = 'in' and tax_percent is not null and tax_percent <> ''
     and abs(replace(tax_percent, '%', '')::numeric - 100.0 * tax_cents / nullif(amount_cents,0)) > 0.6 limit 20`));
console.log("monthly: withheld vs State 'Tax Payment' record:", await q(sql`
  with w as (select to_char(date_trunc('month', occurred_at at time zone 'Europe/London'), 'YYYY-MM') as m, sum(tax_cents) as withheld from bank_transaction where direction = 'in' group by 1),
       r as (select to_char(date_trunc('month', occurred_at at time zone 'Europe/London'), 'YYYY-MM') as m, sum(amount_cents) as recorded, count(*) as n from bank_transaction where category = 'tax.remittance_record' group by 1)
  select coalesce(w.m, r.m) as month, w.withheld/100 as withheld, r.recorded/100 as recorded_next_month_row, r.n from w full join r on r.m = w.m order by 1`));

h("A6 Journal-entry testing (ISA 240): manual entries");
console.log(await q(sql`
  select e.kind, e.description, e.effective_at::date, e.recorded_at::date, (select sum(debit_cents) from journal_line l where l.entry_id = e.id)/100 as amount, left(coalesce(e.reason, ''), 70) as reason
    from journal_entry e where e.created_by_staff_id is not null or e.reason is not null order by e.recorded_at`));

h("A7 Audit log chain");
console.log(JSON.stringify(await verifyAuditChain()));
process.exit(0);
