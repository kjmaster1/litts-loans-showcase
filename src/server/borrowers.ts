import { SERVER_AGGREGATE } from "@/server/authz/rules";
import { formatDollars } from "@/lib/format";
import "server-only";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { borrowerDirectory, type DirectoryRow } from "@/domain/borrowers/directory";
import { can } from "@/lib/permissions";
import type { Viewer } from "@/server/authz/viewer";
import { db } from "@/server/db";
import { borrowerFlag, loanEvent, mortgageEvent, staff } from "@/server/db/schema";
import { loanCollections, mortgageCollections, type CollectionEntry } from "@/server/loans/collections";
import { lendingCheck, type LendingCheck } from "@/server/loans/lending";
import { canSeeLoan, listLoans, type LoanListRow } from "@/server/loans/queries";
import { canSeeMortgage, listMortgages, type MortgageListRow } from "@/server/mortgages/queries";
import { loanProfits, mortgageProfits } from "@/server/profit";

/**
 * Borrower profile (research/12): everything about one State ID on one page —
 * loans, mortgages, collections and notes, the lending check and do-not-lend flag,
 * what they owe and what they've made Litt's. Anyone with borrower lookup sees the
 * history (as the lookup always has); details of loans and mortgages the viewer
 * doesn't manage stay summary-only, and profit is for finance viewers.
 */

export type ProfileLoan = LoanListRow & { visible: boolean; netCents: number | null };
export type ProfileMortgage = MortgageListRow & { visible: boolean; netCents: number | null };
export type ActivityItem = {
  key: string;
  at: Date;
  on: { type: "loan" | "mortgage"; id: string; label: string };
  staffName: string | null;
} & ({ kind: "collection"; entry: CollectionEntry } | { kind: "note"; text: string });

export type BorrowerProfile = {
  stateId: number;
  name: string | null;
  loans: ProfileLoan[];
  mortgages: ProfileMortgage[];
  activity: ActivityItem[];
  check: LendingCheck;
  totals: {
    /** Still owed on loans (active, overdue, defaulted). */
    owedCents: number;
    lentCents: number;
    interestPaidCents: number;
    /** Loans finished well / badly. */
    repaid: number;
    wentBad: number;
    missedNow: number;
    /** Finance viewers only. */
    netCents: number | null;
  };
};

const money = formatDollars;

export async function borrowerProfile(viewer: Viewer, stateId: number, request: { amountCents?: number | null; rateBp?: number | null } = {}): Promise<BorrowerProfile> {
  const finance = can(viewer.role, "finance.view");
  const [allLoans, allMortgages, check, profits, mProfits] = await Promise.all([
    listLoans(SERVER_AGGREGATE, { status: "all", q: String(stateId) }),
    listMortgages(SERVER_AGGREGATE, { status: "all", q: String(stateId) }),
    lendingCheck(viewer, stateId, request),
    finance ? loanProfits() : Promise.resolve(null),
    finance ? mortgageProfits() : Promise.resolve(null),
  ]);
  const loans: ProfileLoan[] = allLoans
    .filter((l) => l.borrowerStateId === stateId)
    .map((l) => ({ ...l, visible: canSeeLoan(viewer, l), netCents: profits ? (profits.get(l.id) ?? 0) : null }));
  const mortgages: ProfileMortgage[] = allMortgages
    .filter((m) => m.buyerStateId === stateId)
    .map((m) => ({ ...m, visible: canSeeMortgage(viewer, m), netCents: mProfits ? (mProfits.get(m.id) ?? 0) : null }));

  const seenLoans = loans.filter((l) => l.visible);
  const seenMortgages = mortgages.filter((m) => m.visible);
  const loanLabel = (l: LoanListRow) => `Loan of ${money(l.principalCents)}`;
  const [loanLogs, mortgageLogs, loanNotes, mortgageNotes] = await Promise.all([
    loanCollections(seenLoans.map((l) => l.id)),
    mortgageCollections(seenMortgages.map((m) => m.id)),
    seenLoans.length
      ? db
          .select({ id: loanEvent.id, ref: loanEvent.loanId, at: loanEvent.at, detail: loanEvent.detail, staffName: staff.characterName })
          .from(loanEvent)
          .leftJoin(staff, eq(staff.id, loanEvent.staffId))
          .where(and(eq(loanEvent.kind, "note"), inArray(loanEvent.loanId, seenLoans.map((l) => l.id))))
          .orderBy(desc(loanEvent.at))
      : Promise.resolve([]),
    seenMortgages.length
      ? db
          .select({ id: mortgageEvent.id, ref: mortgageEvent.mortgageId, at: mortgageEvent.at, detail: mortgageEvent.detail, staffName: staff.characterName })
          .from(mortgageEvent)
          .leftJoin(staff, eq(staff.id, mortgageEvent.staffId))
          .where(and(eq(mortgageEvent.kind, "note"), inArray(mortgageEvent.mortgageId, seenMortgages.map((m) => m.id))))
          .orderBy(desc(mortgageEvent.at))
      : Promise.resolve([]),
  ]);
  const loanOn = new Map(seenLoans.map((l) => [l.id, { type: "loan" as const, id: l.id, label: loanLabel(l) }]));
  const mortgageOn = new Map(seenMortgages.map((m) => [m.id, { type: "mortgage" as const, id: m.id, label: m.address }]));
  const activity: ActivityItem[] = [
    ...[...loanLogs].flatMap(([id, list]) => list.map((e) => ({ key: `c-${e.id}`, at: e.at, on: loanOn.get(id)!, staffName: e.staffName, kind: "collection" as const, entry: e }))),
    ...[...mortgageLogs].flatMap(([id, list]) => list.map((e) => ({ key: `c-${e.id}`, at: e.at, on: mortgageOn.get(id)!, staffName: e.staffName, kind: "collection" as const, entry: e }))),
    ...loanNotes.map((n) => ({ key: `ln-${n.id}`, at: n.at, on: loanOn.get(n.ref)!, staffName: n.staffName, kind: "note" as const, text: String(n.detail.text ?? "") })),
    ...mortgageNotes.map((n) => ({ key: `mn-${n.id}`, at: n.at, on: mortgageOn.get(n.ref)!, staffName: n.staffName, kind: "note" as const, text: String(n.detail.text ?? "") })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());

  const owing = (l: LoanListRow) => l.status === "active" || l.status === "overdue" || l.status === "defaulted";
  return {
    stateId,
    name: loans.find((l) => l.borrowerName)?.borrowerName ?? mortgages.find((m) => m.buyerName)?.buyerName ?? null,
    loans,
    mortgages,
    activity,
    check,
    totals: {
      owedCents: loans.filter(owing).reduce((s, l) => s + Math.max(0, l.outstandingCents ?? 0), 0),
      lentCents: loans.reduce((s, l) => s + l.principalCents, 0),
      interestPaidCents: loans.reduce((s, l) => s + l.interestReceivedCents, 0),
      repaid: loans.filter((l) => l.status === "completed").length,
      wentBad: loans.filter((l) => l.status === "defaulted" || l.status === "written_off").length,
      missedNow:
        loans.filter((l) => l.status === "overdue" || l.status === "defaulted").reduce((s, l) => s + (l.lastMissed ?? 0), 0) +
        mortgages.filter((m) => m.status === "active" && (m.state?.kind === "late" || m.state?.kind === "behind")).reduce((s, m) => s + (m.state && "overdue" in m.state ? m.state.overdue : 0), 0),
      netCents: finance ? loans.reduce((s, l) => s + (l.netCents ?? 0), 0) + mortgages.reduce((s, m) => s + (m.netCents ?? 0), 0) : null,
    },
  };
}

/**
 * Everyone who has borrowed (owner, 2026-10-11): the directory behind /loans/borrowers.
 * Same reach as borrower lookup — names, counts and what's owed, never loan details.
 */
export async function listBorrowerDirectory(): Promise<DirectoryRow[]> {
  const [loans, mortgages, flags] = await Promise.all([
    listLoans(SERVER_AGGREGATE, { status: "all" }),
    listMortgages(SERVER_AGGREGATE, { status: "all" }),
    db.select({ stateId: borrowerFlag.borrowerStateId }).from(borrowerFlag).where(isNull(borrowerFlag.clearedAt)),
  ]);
  return borrowerDirectory(
    loans,
    mortgages.map((m) => ({ ...m, late: m.status === "active" && (m.state?.kind === "late" || m.state?.kind === "behind") })),
    new Set(flags.map((f) => f.stateId)),
  );
}
