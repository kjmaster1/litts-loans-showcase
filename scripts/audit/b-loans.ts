// AUDIT B — loans: recalculation & reperformance. Read-only.
import { SERVER_AGGREGATE } from "@/server/authz/rules";
import { sql } from "drizzle-orm";
import { levyFor } from "@/domain/loans/analysis";
import type { LinkRole } from "@/domain/loans/link";
import { wholeDollars } from "@/lib/money";
import { db } from "@/server/db";
import { listLoans } from "@/server/loans/queries";

const q = async <T extends Record<string, unknown>>(s: ReturnType<typeof sql>) => (await db.execute<T>(s)).rows;
const d = (c: number) => `$${(c / 100).toLocaleString("en-US")}`;
const h = (t: string) => console.log(`\n## ${t}`);

const loans = await listLoans(SERVER_AGGREGATE, { status: "all" });
const links = await q<{ loan_id: string; tx: string; role: LinkRole; method: string; at: string; amt: string; tax: string; levy: string; comment: string; recovery: string | null }>(sql`
  select l.loan_id, b.id as tx, l.role, l.method, b.occurred_at as at, b.amount_cents as amt, b.tax_cents as tax, l.levy_cents as levy, b.comment, l.recovery_entry_id as recovery
    from loan_payment_link l join bank_transaction b on b.id = l.bank_transaction_id order by b.occurred_at`);
const byLoan = new Map<string, typeof links>();
for (const r of links) byLoan.set(r.loan_id, [...(byLoan.get(r.loan_id) ?? []), r]);

h("B1 Receivable sub-ledger vs general ledger (1100)");
const [gl] = await q<{ b: string }>(sql`select sum(debit_cents - credit_cents) as b from journal_line where account_code = '1100'`);
const sub = loans.reduce((s, l) => s + (l.outstandingCents ?? 0), 0);
console.log(`GL 1100 ${d(Number(gl.b))} · sum of loan balances ${d(sub)} · difference ${d(Number(gl.b) - sub)}`);
const neg = loans.filter((l) => (l.outstandingCents ?? 0) < 0);
console.log("loans with a negative balance:", neg.map((l) => `${l.borrowerName} ${l.status} ${d(l.outstandingCents!)}`));
const doneNonZero = loans.filter((l) => (l.status === "completed" || l.status === "written_off") && l.outstandingCents !== null && l.outstandingCents !== 0);
console.log("finished loans not at zero:", doneNonZero.map((l) => `${l.borrowerName} ${l.status} ${d(l.outstandingCents!)}`));

h("B2 Regular instalments recalculated from card terms");
type Dev = { who: string; at: string; role: string; actual: number; expected: number; comment: string };
const devs: Dev[] = [];
let checkedP = 0;
let checkedI = 0;
for (const l of loans) {
  if (!l.instalments || l.brokerRateBp === null || l.stateRateBp === null) continue;
  const per = wholeDollars(l.principalCents / l.instalments);
  const s = l.stateRateBp / 10_000;
  const b = l.brokerRateBp / 10_000;
  const expP = per - wholeDollars(per * s);
  const expI = wholeDollars(per * b);
  for (const r of byLoan.get(l.id) ?? []) {
    const amt = Number(r.amt);
    if (r.role === "principal") {
      checkedP++;
      const last = /(\d+)\/(\d+)\s*$/.exec(r.comment);
      const isLast = last && last[1] === last[2];
      // The last instalment takes the remainder of the principal.
      const lastP = l.principalCents - per * (l.instalments - 1);
      const exp = isLast ? lastP - wholeDollars(lastP * s) : expP;
      if (Math.abs(amt - exp) > 100) devs.push({ who: `${l.borrowerName} $${l.principalCents / 100}`, at: r.at.slice(0, 10), role: r.role, actual: amt, expected: exp, comment: r.comment.slice(0, 70) });
    }
    if (r.role === "interest") {
      checkedI++;
      if (Math.abs(amt - expI) > 100) devs.push({ who: `${l.borrowerName} $${l.principalCents / 100}`, at: r.at.slice(0, 10), role: r.role, actual: amt, expected: expI, comment: r.comment.slice(0, 70) });
    }
  }
}
console.log(`regular principal rows checked ${checkedP}, interest rows ${checkedI}; off by more than $1: ${devs.length}`);
const bucket = new Map<string, Dev[]>();
for (const v of devs) {
  const key = v.comment.includes("OVERDUE") ? `${v.role} (overdue card)` : v.role;
  bucket.set(key, [...(bucket.get(key) ?? []), v]);
}
for (const [k, list] of bucket) {
  console.log(`  ${k}: ${list.length}`);
  for (const v of list.slice(0, 8)) console.log(`    ${v.who} ${v.at} actual ${d(v.actual)} expected ${d(v.expected)} ratio ${(v.actual / v.expected).toFixed(3)} | ${v.comment}`);
}

h("B3 State levy recomputed per receipt (stored vs formula)");
let levyChecked = 0;
const levyDiffs: string[] = [];
for (const l of loans) {
  if (l.brokerRateBp === null || l.stateRateBp === null) continue;
  for (const r of byLoan.get(l.id) ?? []) {
    if (!["principal", "early_principal", "late_principal"].includes(r.role) || r.recovery) continue;
    levyChecked++;
    const exp = levyFor(r.role, Number(r.amt), { brokerRate: l.brokerRateBp / 10_000, stateRate: l.stateRateBp / 10_000 });
    if (exp !== Number(r.levy)) levyDiffs.push(`${l.borrowerName} ${r.at.slice(0, 10)} ${r.role} ${d(Number(r.amt))}: stored ${d(Number(r.levy))} formula ${d(exp)}`);
  }
}
console.log(`receipts checked ${levyChecked}; stored ≠ formula: ${levyDiffs.length}`, levyDiffs.slice(0, 10));
const [levyGl] = await q<{ b: string }>(sql`select sum(debit_cents - credit_cents) as b from journal_line where account_code = '5100'`);
const levySub = links.reduce((s, r) => s + Number(r.levy), 0);
console.log(`GL 5100 ${d(Number(levyGl.b))} vs Σ stored levies ${d(levySub)} → ${d(Number(levyGl.b) - levySub)}`);

h("B4 Interest received vs contract, finished loans");
for (const status of ["completed", "written_off", "defaulted"] as const) {
  let contract = 0;
  let got = 0;
  let n = 0;
  for (const l of loans.filter((x) => x.status === status && x.instalments && x.brokerRateBp !== null)) {
    n++;
    const per = wholeDollars(l.principalCents / l.instalments!);
    contract += wholeDollars(per * (l.brokerRateBp! / 10_000)) * l.instalments!;
    got += (byLoan.get(l.id) ?? []).filter((r) => ["interest", "early_interest", "late_fee"].includes(r.role)).reduce((s, r) => s + Number(r.amt), 0);
  }
  console.log(`${status}: ${n} loans · contract interest ${d(contract)} · received ${d(got)} · ${got >= contract ? "over" : "under"} by ${d(Math.abs(got - contract))} (${((got / contract) * 100).toFixed(1)}%)`);
}

h("B5 Broker fees: one per loan?");
const fees = await q<{ sid: number; who: string; day: string; n: string; total: string; loans: string }>(sql`
  select g.*, (select count(*) from bank_transaction x where x.category = 'loan.disbursement' and x.initiator_state_id = g.sid and x.occurred_at::date = g.day) as loans
    from (select b.initiator_state_id as sid, max(b.initiator_name) as who, b.occurred_at::date as day, count(*) as n, sum(b.amount_cents)/100 as total
            from bank_transaction b where b.category = 'loan.origination_fee' group by 1, 3 having count(*) > 1 or sum(b.amount_cents) > 100) g order by g.day`);
for (const f of fees) console.log(`  ${f.day} ${f.who} #${f.sid}: ${f.n} fee rows totalling $${f.total}, loans paid out that day: ${f.loans}`);
const feeLinks = await q<{ n: string; m: string }>(sql`select count(*) filter (where l.role = 'fee') as n, count(*) filter (where b.category = 'loan.origination_fee' and l.bank_transaction_id is null) as m from bank_transaction b left join loan_payment_link l on l.bank_transaction_id = b.id where b.category = 'loan.origination_fee'`);
console.log("fee rows linked / unlinked:", feeLinks);

h("B6 Payments outside a loan's life, and repeats");
const outside: string[] = [];
const repeats: string[] = [];
for (const l of loans) {
  const rows = (byLoan.get(l.id) ?? []).filter((r) => r.role !== "disbursement" && r.role !== "recovery");
  for (const r of rows) {
    if (l.openedAt && new Date(r.at) < l.openedAt) outside.push(`${l.borrowerName}: ${r.role} ${d(Number(r.amt))} on ${r.at.slice(0, 16)} before the loan opened`);
    if (l.completedAt && new Date(r.at).getTime() > l.completedAt.getTime() + 86_400_000) outside.push(`${l.borrowerName}: ${r.role} ${d(Number(r.amt))} on ${r.at.slice(0, 16)} after completion (${l.completedAt.toISOString().slice(0, 10)})`);
  }
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1];
    const b = rows[i];
    if (a.role === b.role && a.amt === b.amt && Math.abs(new Date(a.at).getTime() - new Date(b.at).getTime()) < 120_000)
      repeats.push(`${l.borrowerName}: two ${a.role} of ${d(Number(a.amt))} within 2 min (${a.at.slice(0, 16)}) | ${a.comment.slice(0, 50)}`);
  }
}
console.log(`outside: ${outside.length}`, outside.slice(0, 15));
console.log(`repeats: ${repeats.length}`, repeats.slice(0, 15));

h("B7 Unlinked loan-category rows");
console.log(await q(sql`select b.category, count(*), sum(b.amount_cents)/100 as amt from bank_transaction b where b.category like 'loan.%' and not exists (select 1 from loan_payment_link l where l.bank_transaction_id = b.id) group by 1`));

h("B8 Write-offs");
const wo = await q<{ who: string; principal: string; written: string; at: string; recovered: string }>(sql`
  select l.borrower_name as who, l.principal_cents as principal, (select sum(debit_cents) from journal_line where entry_id = l.write_off_entry_id and account_code = '5300') as written, l.written_off_at as at,
         (select coalesce(sum(b.amount_cents), 0) from loan_payment_link k join bank_transaction b on b.id = k.bank_transaction_id where k.loan_id = l.id and k.role = 'recovery') as recovered
    from loan l where l.status = 'written_off' order by l.written_off_at`);
for (const w of wo) console.log(`  ${w.who}: principal ${d(Number(w.principal))}, written off ${d(Number(w.written))}, recoveries linked ${d(Number(w.recovered))}`);
const [glw] = await q<{ b: string }>(sql`select sum(debit_cents - credit_cents) as b from journal_line where account_code = '5300'`);
console.log(`GL 5300 ${d(Number(glw.b))} vs Σ write-offs ${d(wo.reduce((s, w) => s + Number(w.written), 0))}`);
process.exit(0);
