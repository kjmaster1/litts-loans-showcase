// AUDIT A5b — does each State "Tax Payment" record cover the tax withheld since the previous record? Read-only.
import { sql } from "drizzle-orm";
import { db } from "@/server/db";

const rows = (
  await db.execute<{ at: string; recorded: string; withheld: string; n: string; first: string | null; last: string | null }>(sql`
    with r as (select occurred_at as at, amount_cents, lag(occurred_at) over (order by occurred_at) as prev from bank_transaction where category = 'tax.remittance_record')
    select r.at, r.amount_cents as recorded,
           coalesce((select sum(tax_cents) from bank_transaction b where b.direction = 'in' and b.occurred_at <= r.at and (r.prev is null or b.occurred_at > r.prev)), 0) as withheld,
           (select count(*) from bank_transaction b where b.direction = 'in' and b.tax_cents > 0 and b.occurred_at <= r.at and (r.prev is null or b.occurred_at > r.prev)) as n
      from r order by r.at`)
).rows;
let cum = 0;
for (const r of rows) {
  const d = (Number(r.recorded) - Number(r.withheld)) / 100;
  cum += d;
  console.log(`${String(r.at).slice(0, 16)}  record $${Number(r.recorded) / 100}  withheld since last $${Number(r.withheld) / 100}  diff ${d}  (cumulative ${cum})`);
}
const [after] = (await db.execute<{ t: string }>(sql`select coalesce(sum(tax_cents),0) as t from bank_transaction where direction='in' and occurred_at > (select max(occurred_at) from bank_transaction where category='tax.remittance_record')`)).rows;
console.log(`withheld since the last record (due in the next one): $${Number(after.t) / 100}`);
process.exit(0);
