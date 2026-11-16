import "server-only";
import { isLiveQuote } from "@/domain/origination/quote-status";
import { wholeDollars } from "@/lib/money";
import type { Viewer } from "@/server/authz/viewer";
import { myCommission, schemeStarted } from "@/server/commissions/queries";
import { collectionsQueue, type QueueRow } from "@/server/loans/collections";
import { listLoans, type LoanListRow } from "@/server/loans/queries";
import { listMortgages } from "@/server/mortgages/queries";
import { listOffers, type OfferRow } from "@/server/origination/loan-offers";
import { listQuotes, type QuoteRow } from "@/server/origination/mortgage-quotes";

/**
 * My work (owner, 2026-10-11): one officer's day — payments coming in this week,
 * borrowers to chase, offers and quotes still open, and their commission so far.
 * Everything is the viewer's own (officer = them), whatever their role.
 */

export type DueLoan = LoanListRow & { weeklyCents: number | null };

export type MyWork = {
  loans: { open: number; owedCents: number; overdue: number };
  mortgages: { open: number; late: number };
  dueThisWeek: DueLoan[];
  toChase: QueueRow[];
  offers: OfferRow[];
  quotes: QuoteRow[];
  commission: { started: boolean; weekLabel: string | null; estimateCents: number; owedCents: number };
};

const WEEK = 7 * 86_400_000;

/** A loan's regular instalment: principal / N plus the broker's interest on it. */
function weekly(l: LoanListRow): number | null {
  if (!l.instalments || l.brokerRateBp === null) return null;
  return wholeDollars((l.principalCents / l.instalments) * (1 + l.brokerRateBp / 10_000));
}

export async function myWork(viewer: Viewer, now: Date = new Date()): Promise<MyWork> {
  const mine = <T extends { officerStaffId: string | null }>(r: T) => r.officerStaffId === viewer.staffId;
  const [loans, mortgages, queue, offers, quotes, commission] = await Promise.all([
    listLoans(viewer, { status: "all", officer: "mine" }),
    listMortgages(viewer, { status: "active" }).then((all) => all.filter(mine)),
    collectionsQueue(viewer, now).then((all) => all.filter(mine)),
    listOffers(viewer, { status: "open" }).then((all) => all.filter(mine)),
    listQuotes(viewer).then((all) => all.filter((q) => isLiveQuote(q.status) && mine(q))),
    myCommission(viewer.staffId, now),
  ]);
  const open = loans.filter((l) => l.status === "active" || l.status === "overdue" || l.status === "defaulted");
  const dueThisWeek = open
    .filter((l) => l.status !== "defaulted" && l.nextPaymentDueAt && l.nextPaymentDueAt.getTime() <= now.getTime() + WEEK)
    .sort((a, b) => a.nextPaymentDueAt!.getTime() - b.nextPaymentDueAt!.getTime())
    .map((l) => ({ ...l, weeklyCents: weekly(l) }));
  return {
    loans: {
      open: open.length,
      owedCents: open.reduce((s, l) => s + Math.max(0, l.outstandingCents ?? 0), 0),
      overdue: open.filter((l) => l.status !== "active").length,
    },
    mortgages: { open: mortgages.length, late: mortgages.filter((m) => m.state?.kind === "late" || m.state?.kind === "behind").length },
    dueThisWeek,
    // Cases that need something now first, then the rest by priority.
    toChase: queue.filter((r) => r.status !== "written_off").sort((a, b) => Number(b.due) - Number(a.due) || b.priority - a.priority),
    offers,
    quotes,
    commission: {
      started: schemeStarted(now),
      weekLabel: commission.current?.label ?? null,
      estimateCents: commission.current?.estimateCents ?? 0,
      owedCents: commission.balance?.owedCents ?? 0,
    },
  };
}
