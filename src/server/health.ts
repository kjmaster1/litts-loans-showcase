import "server-only";
import { sql } from "drizzle-orm";
import type { HealthLoan } from "@/domain/health";
import { db } from "@/server/db";
import type { LoanListRow } from "@/server/loans/queries";

/** Loans with their bank payment history, for portfolio health (domain/health.ts). */
export async function healthLoans(loans: LoanListRow[]): Promise<HealthLoan[]> {
  const rows = await db.execute<{ loan_id: string; at: Date; gross: string; principal: string; instalment: boolean }>(sql`
    select l.loan_id, b.occurred_at as at, b.amount_cents as gross, l.role in ('principal', 'late_principal') as instalment,
           -- Recoveries count against what's owed (a defaulted loan's debt coming back).
           case when l.role in ('principal', 'early_principal', 'late_principal') then b.amount_cents + l.levy_cents - l.penalty_cents
                when l.role = 'recovery' then b.amount_cents else 0 end as principal
      from loan_payment_link l join bank_transaction b on b.id = l.bank_transaction_id
     where l.role not in ('disbursement', 'fee', 'refund')`);
  const byLoan = new Map<string, HealthLoan["payments"]>();
  const instalmentsPaidAt = new Map<string, Date[]>();
  for (const r of rows.rows) {
    const list = byLoan.get(r.loan_id) ?? [];
    list.push({ at: new Date(r.at), grossCents: Number(r.gross), principalCents: Number(r.principal) });
    byLoan.set(r.loan_id, list);
    if (r.instalment) instalmentsPaidAt.set(r.loan_id, [...(instalmentsPaidAt.get(r.loan_id) ?? []), new Date(r.at)]);
  }
  return loans
    .filter((l) => l.openedAt && l.instalments)
    .map((l) => ({
      id: l.id,
      openedAt: l.openedAt!,
      principalCents: l.principalCents,
      instalments: l.instalments!,
      periodDays: l.periodDays,
      brokerRateBp: l.brokerRateBp,
      completedAt: l.completedAt,
      firstDefaultAt: l.firstDefaultAt,
      writtenOffAt: l.writtenOffAt,
      payments: byLoan.get(l.id) ?? [],
      instalmentsPaidAt: instalmentsPaidAt.get(l.id) ?? [],
    }));
}
