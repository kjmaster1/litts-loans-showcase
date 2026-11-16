import { formatCents } from "@/lib/format";
import "server-only";
import { desc, isNull } from "drizzle-orm";
import { can } from "@/lib/permissions";
import type { Viewer } from "@/server/authz/viewer";
import { cashBalanceCents } from "@/server/bank/import";
import { myCommission, payouts, schemeStarted, weeksOverview } from "@/server/commissions/queries";
import { unconfirmedRecords } from "@/server/data-quality";
import { db } from "@/server/db";
import { allowanceReading } from "@/server/db/schema";
import { reviewCount } from "@/server/ledger/queries";
import { lastPasteByTab, staleTabs } from "@/server/loans/paste";
import { collectionsQueueForRequest } from "@/server/loans/collections";
import { loanKpis } from "@/server/loans/queries";
import { mortgageKpis } from "@/server/mortgages/queries";

/** The dashboard: headline figures and a to-do list, each limited to what the viewer may see. */

export type Todo = { id: string; label: string; detail: string; href: string; tone: "warning" | "danger" | "info" };
export type Headline = { label: string; cents?: number; count?: number; hint: string; href: string };

/** Money still to come in from loans and mortgages already running (finance viewers). */
export type Expected = {
  totalCents: number;
  lines: { label: string; cents: number; hint: string; href: string }[];
  /** Not in the total: defaulted loans, if recovered in full. */
  defaultedCents: number;
};

const DAY = 86_400_000;

export async function dashboard(viewer: Viewer, now: Date = new Date()): Promise<{ headlines: Headline[]; todos: Todo[]; expected: Expected | null }> {
  const finance = can(viewer.role, "finance.view");
  const paste = can(viewer.role, "imports.paste");
  const writeOff = can(viewer.role, "loans.charge_off");
  const commissions = can(viewer.role, "commissions.manage");
  const started = schemeStarted(now);

  const [loans, mortgages, cash, review, lastPaste, weeks, payoutRows, mine, lastReading, collections, unconfirmed] = await Promise.all([
    loanKpis(viewer),
    mortgageKpis(viewer),
    finance ? cashBalanceCents() : Promise.resolve(null),
    finance ? reviewCount() : Promise.resolve(0),
    paste ? lastPasteByTab() : Promise.resolve(null),
    commissions && started ? weeksOverview(now) : Promise.resolve([]),
    commissions && started ? payouts(100) : Promise.resolve([]),
    started ? myCommission(viewer.staffId, now) : Promise.resolve(null),
    can(viewer.role, "allowance.record")
      ? db.select({ at: allowanceReading.observedAt }).from(allowanceReading).where(isNull(allowanceReading.voidedAt)).orderBy(desc(allowanceReading.observedAt)).limit(1)
      : Promise.resolve(null),
    collectionsQueueForRequest(viewer),
    can(viewer.role, "records.merge") ? unconfirmedRecords() : Promise.resolve([]),
  ]);

  const headlines: Headline[] = [
    ...(cash !== null ? [{ label: "Cash", cents: cash, hint: "Business wallet, per the books", href: "/finance" }] : []),
    { label: "Loans outstanding", cents: loans.outstandingLiveCents, hint: `${loans.open} active or overdue`, href: "/loans" },
    { label: "Mortgages", count: mortgages.active, hint: mortgages.behind + mortgages.late ? `${mortgages.behind + mortgages.late} late or behind` : "All on track", href: "/mortgages" },
    ...(mine
      ? [{ label: "Your commission this week", cents: mine.current?.estimateCents ?? 0, hint: mine.balance?.owedCents ? `Owed to you: ${formatCents(mine.balance.owedCents)}` : "Estimate until the week closes", href: "/commissions" }]
      : []),
  ];

  const todos: Todo[] = [];
  if (unconfirmed.length) {
    // Pasted records the bank should have confirmed by now: most likely duplicates or typos.
    todos.push({
      id: "unconfirmed",
      label: "Check records the bank doesn’t confirm",
      detail: `${unconfirmed.length} pasted ${unconfirmed.length === 1 ? "record has" : "records have"} no bank money though the export has moved past ${unconfirmed.length === 1 ? "it" : "them"}. Duplicate or typo?`,
      href: unconfirmed[0].href,
      tone: "danger",
    });
  }
  if (lastPaste) {
    const stale = staleTabs(lastPaste, 8, now.getTime());
    if (stale.length) todos.push({ id: "paste", label: "Paste the phone tabs", detail: `${stale.length} tab${stale.length === 1 ? "" : "s"} not pasted this week`, href: "/loans/import", tone: "warning" });
  }
  if (review > 0) todos.push({ id: "review", label: "Classify bank transactions", detail: `${review} waiting for review`, href: "/finance/transactions?view=review", tone: "warning" });
  if (paste && mortgages.unpasted > 0) todos.push({ id: "tablet", label: "Paste mortgages from the tablet", detail: `${mortgages.unpasted} without their details`, href: "/mortgages?status=unpasted", tone: "info" });
  if (mortgages.behind > 0) todos.push({ id: "behind", label: "Mortgages behind on payments", detail: `${mortgages.behind} past the grace period`, href: "/mortgages?status=behind", tone: "danger" });
  if (loans.overdue > 0) todos.push({ id: "overdue", label: "Overdue loans", detail: `${loans.overdue} missed a payment`, href: "/loans?status=overdue", tone: "warning" });
  const broken = collections.filter((c) => c.last?.outcome?.state === "broken").length;
  if (broken) todos.unshift({ id: "broken", label: "Broken promises to pay", detail: `${broken} borrower${broken === 1 ? "" : "s"} didn't pay what they promised`, href: "/loans/collections", tone: "danger" });
  const chase = collections.filter((c) => c.due && c.last?.outcome?.state !== "broken").length;
  if (chase) todos.push({ id: "collections", label: "Chase late payers", detail: `${chase} not contacted or follow-up due`, href: "/loans/collections", tone: "warning" });
  if (writeOff && loans.dueForWriteOff > 0) todos.push({ id: "writeoff", label: "Review defaults for write-off", detail: `${loans.dueForWriteOff} defaulted over 28 days ago`, href: "/loans?status=defaulted", tone: "danger" });
  if (loans.unassigned > 0 && can(viewer.role, "loans.reassign_officer")) todos.push({ id: "officers", label: "Assign loan officers", detail: `${loans.unassigned} open loan${loans.unassigned === 1 ? "" : "s"} without one`, href: "/loans?status=live&officer=unassigned", tone: "info" });
  const toClose = weeks.filter((w) => w.ended && w.status === "open");
  if (toClose.length) todos.push({ id: "weeks", label: "Close commission weeks", detail: `${toClose.length} ended and waiting`, href: `/commissions/${toClose[0].key}`, tone: "warning" });
  const unmatched = payoutRows.filter((p) => p.status === "unmatched").length;
  if (unmatched) todos.push({ id: "payouts", label: "Assign commission payouts", detail: `${unmatched} not matched to a person`, href: "/commissions", tone: "info" });
  if (lastReading !== null) {
    const at = lastReading[0]?.at;
    if (!at || now.getTime() - at.getTime() > 7 * DAY) todos.push({ id: "allowance", label: "Record the State allowance", detail: at ? "No reading in the last week" : "No readings yet", href: "/finance/allowance", tone: "info" });
  }
  const expectedLines = [
    { label: "Loan principal", cents: loans.outstandingLiveCents - loans.stateShareToComeCents, hint: "Still owed on active and overdue loans, less the State's share", href: "/loans" },
    { label: "Loan interest", cents: loans.interestToComeCents, hint: "Interest on that principal", href: "/loans" },
    { label: "Mortgage broker interest", cents: mortgages.brokerInterestToComeCents, hint: "Litt's share of the remaining instalments", href: "/mortgages" },
    { label: "Company-funded mortgages", cents: mortgages.owedToCompanyCents, hint: "Principal Litt's lent from its own money", href: "/mortgages" },
  ];
  const expected: Expected | null = finance
    ? {
        totalCents: expectedLines.reduce((s, l) => s + l.cents, 0),
        lines: expectedLines,
        defaultedCents: loans.defaultedOutstandingCents + loans.defaultedInterestToComeCents,
      }
    : null;
  return { headlines, todos, expected };
}
