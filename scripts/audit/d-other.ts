// AUDIT D/E — commissions, equity, other categories, P&L analytics; app figures vs the books. Read-only.
import { SERVER_AGGREGATE } from "@/server/authz/rules";
import { sql } from "drizzle-orm";
import { db } from "@/server/db";
import { profitAndLoss, trialBalance } from "@/server/ledger/queries";
import { listLoans } from "@/server/loans/queries";
import { loanProfits, mortgageProfits } from "@/server/profit";
import { buildReport, parseRange } from "@/server/reports/reports";
import { expectedLosses } from "@/server/risk";

const q = async (s: ReturnType<typeof sql>) => (await db.execute(s)).rows as Record<string, unknown>[];
const h = (t: string) => console.log(`\n## ${t}`);
const d = (c: unknown) => `$${(Number(c) / 100).toLocaleString("en-US")}`;

h("D1 Trial balance (all accounts with a balance)");
const tb = await trialBalance({});
for (const a of tb.filter((x) => x.balanceCents !== 0)) console.log(`  ${a.code} ${a.name.padEnd(42)} ${a.type.padEnd(9)} ${d(a.balanceCents)}`);
const sum = (t: string) => tb.filter((a) => a.type === t).reduce((s, a) => s + a.balanceCents, 0);
console.log(`  assets ${d(sum("asset"))} = liabilities ${d(sum("liability"))} + equity ${d(sum("equity"))} + profit ${d(sum("income") - sum("expense"))} → ${d(sum("asset") - sum("liability") - sum("equity") - (sum("income") - sum("expense")))}`);

h("D2 Commissions: liability 2000 = closed awards − matched payouts; expense 5000");
console.log(await q(sql`
  select (select coalesce(sum(a.amount_cents), 0) from commission_award a join commission_week w on w.id = a.week_id where w.status = 'closed')/100 as awarded,
         (select coalesce(sum(b.amount_cents), 0) from commission_payout p join bank_transaction b on b.id = p.bank_transaction_id where p.status = 'matched')/100 as paid,
         (select coalesce(sum(credit_cents - debit_cents), 0) from journal_line where account_code = '2000')/100 as liability_2000,
         (select count(*) from commission_week where status = 'closed') as weeks_closed,
         (select count(*) from commission_payout where status = 'unmatched') as unmatched_payouts`));
console.log("  commission category rows (old scheme, expensed directly):", await q(sql`select count(*), sum(amount_cents)/100 as total from bank_transaction where category = 'commission'`));
console.log("  commission lines: base × rate check (closed weeks):", await q(sql`select count(*) as lines, count(*) filter (where amount_cents % 100 <> 0) as not_whole_dollars from commission_line`));

h("D3 Every category: rows, money, account (classification review)");
for (const r of await q(sql`select category, direction, count(*) as n, sum(amount_cents) as amt, sum(tax_cents) as tax from bank_transaction group by 1, 2 order by 1`))
  console.log(`  ${String(r.category).padEnd(32)} ${String(r.direction).padEnd(3)} ${String(r.n).padStart(4)} rows  ${d(r.amt).padStart(14)}  tax ${d(r.tax)}`);
console.log("  refunds (out):");
for (const r of await q(sql`select occurred_at::date as day, amount_cents/100 as amt, target_wallet, left(comment, 70) as c from bank_transaction where category = 'refund' and direction = 'out' order by 1`))
  console.log(`    ${r.day} $${r.amt} → ${r.target_wallet} ${r.c}`);
console.log("  capital contributions:");
for (const r of await q(sql`select occurred_at::date as day, amount_cents/100 as amt, tax_cents/100 as tax, initiator_name, left(comment, 60) as c from bank_transaction where category like 'capital.%' order by 1`))
  console.log(`    ${r.day} $${r.amt} (tax ${r.tax}) ${r.initiator_name}: ${r.c}`);

h("D4 Analytical review: P&L by month");
for (const m of await q(sql`
  select to_char(date_trunc('month', e.effective_at at time zone 'Europe/London'), 'YYYY-MM') as m,
         sum(case when a.type = 'income' then l.credit_cents - l.debit_cents else 0 end) as income,
         sum(case when a.type = 'expense' then l.debit_cents - l.credit_cents else 0 end) as expense
    from journal_line l join journal_entry e on e.id = l.entry_id join ledger_account a on a.code = l.account_code group by 1 order by 1`))
  console.log(`  ${m.m}: income ${d(m.income).padStart(12)} expense ${d(m.expense).padStart(12)} net ${d(Number(m.income) - Number(m.expense)).padStart(12)}`);

h("E1 App outputs vs the books");
// Everything up to today (a fixed end date once made the report look $9,817 short of the trial balance).
const all = parseRange("2025-01-01", new Date().toISOString().slice(0, 10));
const pnl = await profitAndLoss(all.from, all.to);
const rep = await buildReport({ staffId: "", userId: "", sessionId: "", role: "ceo", characterName: "audit", stateId: 0, username: "audit", twoFactorEnabled: true, stepUpAt: null, tourCompletedAt: null, tourRole: null }, "pnl", all);
const net = rep.tables.find((t) => t.title === "Net profit")!.rows[0];
console.log(`  P&L report total ${d(net.total)} vs ledger ${d(pnl.netCents)} vs TB profit ${d(sum("income") - sum("expense"))}`);
const bs = await buildReport({ staffId: "", userId: "", sessionId: "", role: "ceo", characterName: "audit", stateId: 0, username: "audit", twoFactorEnabled: true, stepUpAt: null, tourCompletedAt: null, tourRole: null }, "balance", all);
const [assets, liabilities, equity] = bs.tables.map((t) => Number(t.total!.amount));
console.log(`  balance sheet: assets ${d(assets)} = liabilities ${d(liabilities)} + equity ${d(equity)} → ${d(assets - liabilities - equity)}`);
const loans = await listLoans(SERVER_AGGREGATE, { status: "all" });
const lp = await loanProfits();
const mp = await mortgageProfits();
const loanNet = [...lp.values()].reduce((s, v) => s + v, 0);
const mortNet = [...mp.values()].reduce((s, v) => s + v, 0);
console.log(`  Σ net to Litt's: loans ${d(loanNet)} (${lp.size} of ${loans.length}) + mortgages ${d(mortNet)} = ${d(loanNet + mortNet)} of total profit ${d(pnl.netCents)}; rest = legacy, fees not on a loan, costs, tax on non-loan rows`);
const losses = await expectedLosses();
console.log(`  expected losses ${d(losses.expectedCents)} on ${d(losses.owedCents)} owed; loss rates: paying ${(losses.rates.active.rate * 100).toFixed(1)}%, overdue ${(losses.rates.overdue.rate * 100).toFixed(1)}%, defaulted ${(losses.rates.defaulted.rate * 100).toFixed(1)}%, LGD ${(losses.rates.lossGivenDefault * 100).toFixed(1)}%`);
process.exit(0);
