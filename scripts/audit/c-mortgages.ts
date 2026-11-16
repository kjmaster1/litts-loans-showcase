// AUDIT C — mortgages: pass-through, what Litt's keeps vs the tablet, fees, receivable. Read-only.
import { SERVER_AGGREGATE } from "@/server/authz/rules";
import { sql } from "drizzle-orm";
import { db } from "@/server/db";
import { listMortgages } from "@/server/mortgages/queries";

const q = async (s: ReturnType<typeof sql>) => (await db.execute(s)).rows as Record<string, unknown>[];
const h = (t: string) => console.log(`\n## ${t}`);
const d = (c: unknown) => `$${(Number(c) / 100).toLocaleString("en-US")}`;

h("C1 Account balances");
for (const r of await q(sql`select a.code, a.name, sum(l.debit_cents - l.credit_cents) as bal from journal_line l join ledger_account a on a.code = l.account_code where a.code in ('1110','1120','4100','4110') group by 1, 2 order by 1`))
  console.log(`  ${r.code} ${r.name}: ${d(r.bal)}`);

h("C2 Pass-through pairing: every in-leg has its out-leg");
for (const r of await q(sql`
  select b.category, count(*) as n,
         count(*) filter (where exists (select 1 from mortgage_settlement s where (s.in_tx_id = b.id or s.out_tx_id = b.id) and s.unwound_at is null)) as paired
    from bank_transaction b where b.category in ('mortgage.origination_in','mortgage.origination_out','mortgage.repayment_in','mortgage.repayment_out') group by 1 order by 1`))
  console.log(`  ${r.category}: ${r.n} rows, ${r.paired} paired`);
// Old-scheme rows never pair, and a company-funded mortgage's repayments stay with Litt's (no out-leg).
console.log("  unpaired rows that should have paired:");
for (const r of await q(sql`
  select b.occurred_at, b.category, b.amount_cents/100 as amt, left(b.comment, 70) as c from bank_transaction b
   where b.category in ('mortgage.origination_in','mortgage.origination_out','mortgage.repayment_in','mortgage.repayment_out')
     and not exists (select 1 from mortgage_settlement s where (s.in_tx_id = b.id or s.out_tx_id = b.id) and s.unwound_at is null)
     and not exists (select 1 from mortgage_payment p join mortgage m on m.id = p.mortgage_id where p.bank_transaction_id = b.id and m.funding = 'company')
   order by 1`))
  console.log(`    ${String(r.occurred_at).slice(0, 16)} ${r.category} $${r.amt} ${r.c}`);

h("C3 Repayments: what Litt's keeps vs the tablet's broker interest per instalment");
const pays = await q(sql`
  select m.address, m.instalments, m.broker_interest_cents as bi, m.federal_interest_cents as fi, m.loan_cents as loan, m.funding,
         b.occurred_at as at, b.amount_cents as gross, b.tax_cents as tax, o.amount_cents as out
    from mortgage_payment p join mortgage m on m.id = p.mortgage_id join bank_transaction b on b.id = p.bank_transaction_id
    left join mortgage_settlement s on s.in_tx_id = b.id and s.unwound_at is null left join bank_transaction o on o.id = s.out_tx_id
   where m.merged_into_id is null order by m.address, b.occurred_at`);
let checked = 0;
const off: string[] = [];
for (const p of pays) {
  if (!p.instalments || p.bi === null) continue;
  checked++;
  const n = Number(p.instalments);
  const perBroker = Math.floor(Number(p.bi) / n / 100) * 100;
  const perFed = p.fi === null ? 0 : Math.floor(Number(p.fi) / n / 100) * 100;
  const kept = Number(p.gross) - Number(p.tax) - Number(p.out ?? 0);
  const expectKept = p.funding === "company" ? Number(p.gross) - Number(p.tax) : perBroker;
  // Tax withheld should be the federal interest share.
  const taxOk = Math.abs(Number(p.tax) - perFed) <= 100;
  if (Math.abs(kept - expectKept) > 200 || !taxOk)
    off.push(`${p.address} ${String(p.at).slice(0, 10)}: gross ${d(p.gross)} tax ${d(p.tax)} (fed/inst ${d(perFed)}) to State ${d(p.out ?? 0)} kept ${d(kept)} (broker/inst ${d(perBroker)})`);
}
console.log(`  repayments checked ${checked}; off by > $2 or tax ≠ federal share: ${off.length}`);
off.slice(0, 20).forEach((o) => console.log("   " + o));

h("C4 Originations: down payment & fees vs tablet; banker fee % of (down + loan)");
for (const r of await q(sql`
  select m.address, m.funding, m.price_cents as price, m.down_payment_cents as down, m.loan_cents as loan, m.broker_fee_cents as fee, m.agency_commission_cents as agency,
         i.amount_cents as in_amt, i.tax_cents as in_tax, o.amount_cents as out_amt,
         -- Company-funded: the funding entry moves the loan out of 4100 into the receivable (1120).
         (select sum(l.credit_cents - l.debit_cents) from journal_line l
           where l.account_code = '4100' and (l.entry_id = s.journal_entry_id or l.entry_id = m.funding_entry_id)) as booked_fee
    from mortgage m left join bank_transaction i on i.id = m.origination_tx_id
    left join mortgage_settlement s on s.in_tx_id = i.id and s.kind = 'origination' and s.unwound_at is null
    left join bank_transaction o on o.id = s.out_tx_id
   where m.merged_into_id is null and m.down_payment_cents is not null order by m.originated_at`)) {
  const residual = Number(r.in_amt ?? 0) - Number(r.in_tax ?? 0) - Number(r.out_amt ?? 0);
  const basis = Number(r.down) + Number(r.loan);
  const pct = r.fee !== null ? ((Number(r.fee) / basis) * 100).toFixed(2) : "?";
  const flag =
    r.funding === "state" && Math.abs(residual - Number(r.fee ?? 0)) > 200
      ? "  ← kept ≠ tablet banker fee"
      : Math.abs(Number(r.booked_fee ?? 0) - Number(r.fee ?? 0)) > 200
        ? "  ← booked ≠ tablet banker fee"
        : "";
  console.log(`  ${String(r.address).padEnd(26)} ${r.funding} in ${d(r.in_amt)} tax ${d(r.in_tax)} out ${d(r.out_amt)} kept ${d(residual)} | tablet fee ${d(r.fee)} (${pct}% of down+loan) booked 4100 ${d(r.booked_fee)}${flag}`);
}

h("C5 Company-funded receivable (1120) vs principal still owed");
const ms = await listMortgages(SERVER_AGGREGATE, { status: "all" });
const owed = ms.filter((m) => m.funding === "company").reduce((s, m) => s + (m.principalRemainingCents ?? 0), 0);
const [r1120] = await q(sql`select sum(debit_cents - credit_cents) as b from journal_line where account_code = '1120'`);
console.log(`  GL 1120 ${d(r1120.b)} vs company-funded principal remaining ${d(owed)} → ${d(Number(r1120.b) - owed)}`);
process.exit(0);
