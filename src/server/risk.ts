import "server-only";
import { SERVER_AGGREGATE } from "@/server/authz/rules";
import { cache } from "react";
import { sql } from "drizzle-orm";
import { everBehind, sinceDefault } from "@/domain/health";
import { expectedLoss, lossRates, type LossRates, type RiskBucket } from "@/domain/risk";
import { db } from "@/server/db";
import { healthLoans } from "@/server/health";
import { listLoans } from "@/server/loans/queries";
import { listMortgages } from "@/server/mortgages/queries";

/** Expected losses on the book (research/12) — a figure for the dashboard and reports, never booked. */

export type LossBucket = { bucket: RiskBucket; label: string; count: number; owedCents: number; expectedCents: number };
export type LossView = {
  rates: LossRates;
  buckets: LossBucket[];
  /** Still owed to Litt's on loans (active, overdue, defaulted) and company-funded mortgages. */
  owedCents: number;
  expectedCents: number;
  /** What the book is realistically worth: owed less expected losses. */
  realisticCents: number;
};

const LABEL: Record<RiskBucket, string> = { active: "Paying", overdue: "Overdue or behind", defaulted: "Defaulted" };

/** Company-wide (finance viewers only — callers check). One per request. */
export const expectedLosses = cache(async (): Promise<LossView> => {
  const now = new Date();
  const [loans, overdueSeen, mortgages] = await Promise.all([
    listLoans(SERVER_AGGREGATE, { status: "all" }),
    // Seen in the Overdue tab, or a card showing a missed payment.
    db.execute<{ loan_id: string }>(sql`
      select distinct c.loan_id from loan_card c join loan_paste p on p.id = c.paste_id
       where c.loan_id is not null and (p.tab = 'overdue' or coalesce((c.parsed->>'missedPayments')::int, 0) > 0)`),
    listMortgages(SERVER_AGGREGATE, { status: "active" }),
  ]);
  const seen = new Set(overdueSeen.rows.map((r) => r.loan_id));
  const schedules = new Map((await healthLoans(loans)).map((h) => [h.id, h]));

  // Loans that went bad: what they owed when they defaulted, and what came back since.
  const badDebts = { owedCents: 0, recoveredCents: 0 };
  for (const l of loans) {
    const h = schedules.get(l.id);
    if (!h || (l.status !== "defaulted" && l.status !== "written_off")) continue;
    const d = sinceDefault(h);
    if (!d) continue;
    badDebts.owedCents += d.owedCents;
    badDebts.recoveredCents += d.recoveredCents;
  }
  const rates = lossRates(
    loans.map((l) => {
      const h = schedules.get(l.id);
      return {
        status: l.status,
        // The phone's history is short; the schedule against the bank fills the gap.
        everOverdue: l.status === "overdue" || (l.lastMissed ?? 0) > 0 || seen.has(l.id) || (h ? everBehind(h, now) : false),
        everDefaulted: l.firstDefaultAt !== null || l.status === "defaulted" || l.status === "written_off",
      };
    }),
    badDebts,
  );

  const exposures: { bucket: RiskBucket; owedCents: number }[] = [
    ...loans
      .filter((l) => l.status === "active" || l.status === "overdue" || l.status === "defaulted")
      .map((l) => ({ bucket: l.status as RiskBucket, owedCents: Math.max(0, l.outstandingCents ?? 0) })),
    // Only company-funded mortgages put Litt's own money at risk.
    ...mortgages
      .filter((m) => m.funding === "company")
      .map((m) => ({
        bucket: (m.state?.kind === "late" || m.state?.kind === "behind" ? "overdue" : "active") as RiskBucket,
        owedCents: Math.max(0, m.principalRemainingCents ?? 0),
      })),
  ];
  const buckets = (["active", "overdue", "defaulted"] as const).map((bucket) => {
    const list = exposures.filter((e) => e.bucket === bucket);
    const owedCents = list.reduce((s, e) => s + e.owedCents, 0);
    return { bucket, label: LABEL[bucket], count: list.length, owedCents, expectedCents: list.reduce((s, e) => s + expectedLoss(e.owedCents, bucket, rates), 0) };
  });
  const owedCents = buckets.reduce((s, b) => s + b.owedCents, 0);
  const expectedCents = buckets.reduce((s, b) => s + b.expectedCents, 0);
  return { rates, buckets, owedCents, expectedCents, realisticCents: owedCents - expectedCents };
});
