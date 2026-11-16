// AUDIT F — quantify game bugs/mechanics across the book. Read-only.
import { SERVER_AGGREGATE } from "@/server/authz/rules";
import { sql } from "drizzle-orm";
import { analyseLoan, contractSchedule } from "@/domain/loans/analysis";
import type { LinkRole } from "@/domain/loans/link";
import { wholeDollars } from "@/lib/money";
import { db } from "@/server/db";
import { listLoans } from "@/server/loans/queries";

const d = (c: number) => `$${(c / 100).toLocaleString("en-US")}`;
const loans = await listLoans(SERVER_AGGREGATE, { status: "all" });
const links = (
  await db.execute<{ loan_id: string; tx: string; role: LinkRole; at: string; amt: string; comment: string }>(sql`
    select l.loan_id, b.id as tx, l.role, b.occurred_at as at, b.amount_cents as amt, b.comment from loan_payment_link l join bank_transaction b on b.id = l.bank_transaction_id`)
).rows;
const by = new Map<string, typeof links>();
for (const r of links) by.set(r.loan_id, [...(by.get(r.loan_id) ?? []), r]);

const totals: Record<string, { n: number; cents: number }> = {};
const add = (k: string, c: number) => {
  totals[k] ??= { n: 0, cents: 0 };
  totals[k].n++;
  totals[k].cents += c;
};
let penalty = 0;
let penaltyRows = 0;
let scaledLoans = 0;
for (const l of loans) {
  if (!l.instalments || l.brokerRateBp === null || l.stateRateBp === null || !l.openedAt) continue;
  const terms = { principalCents: l.principalCents, instalments: l.instalments, periodDays: l.periodDays ?? 7, brokerRate: l.brokerRateBp / 10_000, stateRate: l.stateRateBp / 10_000, openedAt: l.openedAt };
  const rows = (by.get(l.id) ?? []).filter((r) => r.role !== "disbursement" && r.role !== "fee" && r.role !== "recovery");
  const a = analyseLoan(terms, rows.map((r) => ({ txId: r.tx, role: r.role, amountCents: Number(r.amt), occurredAt: new Date(r.at) })));
  for (const f of a.flags) add(f.kind, f.cents);
  // Overdue +2% penalty: regular rows on overdue cards above the contract amount.
  const per = wholeDollars(l.principalCents / l.instalments);
  const expP = per - wholeDollars(per * terms.stateRate);
  const expI = wholeDollars(per * terms.brokerRate);
  for (const r of rows) {
    if (!r.comment.includes("OVERDUE")) continue;
    const exp = r.role === "principal" ? expP : r.role === "interest" ? expI : null;
    if (exp && Number(r.amt) > exp + 100) {
      penalty += Number(r.amt) - exp;
      penaltyRows++;
    }
  }
  // Proportional shrink after early repayment: a regular row well below contract after an early payment.
  const firstEarly = rows.find((r) => r.role === "early_principal");
  if (firstEarly && rows.some((r) => r.role === "principal" && new Date(r.at) > new Date(firstEarly.at) && Number(r.amt) < expP * 0.95)) scaledLoans++;
  void contractSchedule;
}
console.log("Game-bug flags across all loans (from the loan analysis):");
for (const [k, v] of Object.entries(totals)) console.log(`  ${k}: ${v.n} loans, ${d(v.cents)}`);
console.log(`Overdue penalty (+2% per missed payment) collected on ${penaltyRows} regular rows: ${d(penalty)}`);
console.log(`Loans whose instalments shrank after an early repayment (proportional rescale): ${scaledLoans}`);
const ref = (
  await db.execute<{ c: string; amt: string }>(sql`select left(comment, 60) as c, amount_cents as amt from bank_transaction where category = 'refund' and direction = 'out' and comment !~* 'broker' and comment !~* '^Employee Pay: Reimbursement$'`)
).rows;
console.log(`Refunds paid out for game errors (excluding repeated broker fees): ${ref.length} rows, ${d(ref.reduce((s, r) => s + Number(r.amt), 0))}`);
process.exit(0);
