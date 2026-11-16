import "server-only";
import { SERVER_AGGREGATE } from "@/server/authz/rules";
import { and, eq, isNull } from "drizzle-orm";
import { forecastByWeek, loanInflows, type Forecast, type Inflow } from "@/domain/forecast";
import { db } from "@/server/db";
import { mortgage } from "@/server/db/schema";
import { listLoans } from "@/server/loans/queries";
import { paymentsByMortgage } from "@/server/mortgages/payments";
import { analysisFor } from "@/server/mortgages/queries";

/** Cash-flow forecast for finance viewers (research/11). Company-wide; callers check `finance.view`. */
export async function cashFlowForecast(now: Date = new Date(), weeks = 8): Promise<Forecast> {
  const [loans, mortgages] = await Promise.all([
    listLoans(SERVER_AGGREGATE, { status: "open" }).then((rows) => rows.filter((r) => r.status === "active" || r.status === "overdue")),
    db
      .select()
      .from(mortgage)
      .where(and(eq(mortgage.status, "active"), isNull(mortgage.mergedIntoId))),
  ]);
  const inflows: Inflow[] = loans.flatMap((l) => loanInflows({ ...l, completed: l.lastCompleted }, now));
  const payments = await paymentsByMortgage(mortgages.map((m) => m.id));
  for (const m of mortgages) {
    const a = analysisFor(m, payments.get(m.id) ?? [], now);
    if (!a) continue;
    for (const i of a.schedule.slice(a.paidCount)) {
      // Litt's keeps the broker interest; on a company-funded mortgage the principal comes back to Litt's too.
      inflows.push({ at: i.dueAt, cents: i.brokerInterestCents + (m.funding === "company" ? i.principalCents : 0), source: "mortgages" });
    }
  }
  return forecastByWeek(inflows, now, weeks);
}
