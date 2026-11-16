import "server-only";
import { canSeeLoan, officerScope, viewerOf, type ListScope } from "@/server/authz/rules";
import { and, asc, desc, eq, ilike, inArray, isNull, ne, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { asStateId, cleanSearch, likeEscape } from "@/lib/search";
import { analyseLoan, type LoanAnalysis } from "@/domain/loans/analysis";
import type { LinkRole } from "@/domain/loans/link";
import { writeOffEligibleAt, type LoanStatus } from "@/domain/loans/status";
import type { Viewer } from "@/server/authz/viewer";
import { db } from "@/server/db";
import { bankTransaction, liveLoan, loan, loanAdjustment, loanCard, loanCollateral, loanEvent, loanPaste, loanPaymentLink, staff } from "@/server/db/schema";
import { RECORD_STATUSES, staffOptionLabel, WORKING_STATUSES } from "@/lib/roles";
import { loanInflows } from "@/domain/forecast";
import { getSettings } from "@/server/settings";

/**
 * Read models for the loan pages. Visibility (SPEC §2): Legal and above see
 * every loan; a loan officer sees their own loans in full and only a summary
 * of other borrowers' history (borrowerSummary).
 */

export const STATUS_FILTERS = ["open", "live", "active", "overdue", "defaulted", "written_off", "completed", "all"] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];
const OPEN: LoanStatus[] = ["active", "overdue", "defaulted"];

/** The loans `viewer` may see in full (authz/rules). */
const visible = (viewer: Viewer): SQL | undefined => officerScope(viewer, loan.officerStaffId);

/** Principal received and State levy per loan, as a subquery. */
function receivedSubquery() {
  return db
    .select({
      loanId: loanPaymentLink.loanId,
      // Principal credited: overdue penalties inside instalments are late fees (owner 2026-10-13).
      principal: sql<string>`sum(case when ${loanPaymentLink.role} in ('principal','early_principal','late_principal') then ${bankTransaction.amountCents} - ${loanPaymentLink.penaltyCents} else 0 end)`.as("principal"),
      interest: sql<string>`sum(case when ${loanPaymentLink.role} in ('interest','early_interest','late_fee') then ${bankTransaction.amountCents} else 0 end)`.as("interest"),
      levy: sql<string>`sum(${loanPaymentLink.levyCents})`.as("levy"),
      lastPaymentAt: sql<Date | null>`max(case when ${loanPaymentLink.role} <> 'disbursement' then ${bankTransaction.occurredAt} end)`.as("last_payment_at"),
    })
    .from(loanPaymentLink)
    .innerJoin(bankTransaction, eq(bankTransaction.id, loanPaymentLink.bankTransactionId))
    .groupBy(loanPaymentLink.loanId)
    .as("received");
}

function adjustedSubquery() {
  return db
    .select({ loanId: loanAdjustment.loanId, adjusted: sql<string>`sum(${loanAdjustment.amountCents})`.as("adjusted") })
    .from(loanAdjustment)
    .groupBy(loanAdjustment.loanId)
    .as("adjusted");
}

export type LoanListRow = {
  id: string;
  borrowerStateId: number;
  borrowerName: string | null;
  principalCents: number;
  openedAt: Date | null;
  status: LoanStatus;
  officerStaffId: string | null;
  officerName: string | null;
  instalments: number | null;
  lastCompleted: number | null;
  lastMissed: number | null;
  brokerRateBp: number | null;
  stateRateBp: number | null;
  periodDays: number | null;
  nextPaymentDueAt: Date | null;
  lastCardAt: Date | null;
  lastPaymentAt: Date | null;
  firstDefaultAt: Date | null;
  completedAt: Date | null;
  writtenOffAt: Date | null;
  principalReceivedCents: number;
  interestReceivedCents: number;
  /** Receivable still on the books; null for a loan known only from a card. */
  outstandingCents: number | null;
};

export async function listLoans(
  /** A viewer (their loans), or SERVER_AGGREGATE for every loan — server-side figures only. */
  scope: ListScope,
  filter: { status?: StatusFilter; q?: string; officer?: "mine" | "unassigned" | string } = {},
): Promise<LoanListRow[]> {
  const viewer = viewerOf(scope);
  const received = receivedSubquery();
  const adjusted = adjustedSubquery();
  const conditions: (SQL | undefined)[] = [liveLoan, viewer ? visible(viewer) : undefined];
  const status = filter.status ?? "open";
  if (status === "open") conditions.push(inArray(loan.status, OPEN));
  else if (status === "live") conditions.push(inArray(loan.status, ["active", "overdue"]));
  else if (status !== "all") conditions.push(eq(loan.status, status));
  const q = cleanSearch(filter.q);
  if (q) {
    const id = asStateId(q);
    conditions.push(/^\d+$/.test(q) ? (id === null ? sql`false` : eq(loan.borrowerStateId, id)) : ilike(loan.borrowerName, `%${likeEscape(q)}%`));
  }
  if (filter.officer === "mine" && viewer) conditions.push(eq(loan.officerStaffId, viewer.staffId));
  else if (filter.officer === "unassigned") conditions.push(isNull(loan.officerStaffId));
  else if (filter.officer && /^[0-9a-f-]{36}$/.test(filter.officer)) conditions.push(eq(loan.officerStaffId, filter.officer));

  const rows = await db
    .select({
      l: loan,
      officerName: staff.characterName,
      principal: received.principal,
      interest: received.interest,
      levy: received.levy,
      lastPaymentAt: received.lastPaymentAt,
      adjusted: adjusted.adjusted,
    })
    .from(loan)
    .leftJoin(staff, eq(staff.id, loan.officerStaffId))
    .leftJoin(received, eq(received.loanId, loan.id))
    .leftJoin(adjusted, eq(adjusted.loanId, loan.id))
    .where(and(...conditions))
    // No row limit: reports, expected losses and the directory total these rows (review 2026-10-13 — a cap of 500
    // would have quietly dropped the oldest loans). About 8 loans a month, so the list stays small for years.
    .orderBy(desc(loan.openedAt), desc(loan.createdAt));

  return rows.map(({ l, officerName, principal, interest, levy, lastPaymentAt, adjusted }) => {
    const p = Number(principal ?? 0);
    const v = Number(levy ?? 0) + Number(adjusted ?? 0);
    return {
      id: l.id,
      borrowerStateId: l.borrowerStateId,
      borrowerName: l.borrowerName,
      principalCents: l.principalCents,
      openedAt: l.openedAt,
      status: l.status,
      officerStaffId: l.officerStaffId,
      officerName,
      instalments: l.instalments,
      lastCompleted: l.lastCompleted,
      lastMissed: l.lastMissed,
      brokerRateBp: l.brokerRateBp,
      stateRateBp: l.stateRateBp,
      periodDays: l.periodDays,
      nextPaymentDueAt: l.nextPaymentDueAt,
      lastCardAt: l.lastCardAt,
      lastPaymentAt: lastPaymentAt ? new Date(lastPaymentAt) : null,
      firstDefaultAt: l.firstDefaultAt,
      completedAt: l.completedAt,
      writtenOffAt: l.writtenOffAt,
      principalReceivedCents: p,
      interestReceivedCents: Number(interest ?? 0),
      outstandingCents: l.disbursementTxId && l.status !== "written_off" ? l.principalCents - p - v : null,
    };
  });
}

export type LoanKpis = {
  open: number;
  overdue: number;
  defaulted: number;
  unassigned: number;
  /** All open loans, defaulted included (still owed until written off). */
  outstandingCents: number;
  /** Active and overdue loans only. */
  outstandingLiveCents: number;
  /** Interest on the principal active and overdue loans still owe (see remainingPrincipal). */
  interestToComeCents: number;
  /** The State's share of that principal — taken off each instalment, never Litt's. */
  stateShareToComeCents: number;
  /** Defaulted loans: principal and contract interest, if recovered in full. */
  defaultedOutstandingCents: number;
  defaultedInterestToComeCents: number;
  dueForWriteOff: number;
};

/** How many loans the viewer may see in each status, for the list's tab labels. */
export async function loanStatusCounts(viewer: Viewer): Promise<Record<LoanStatus, number>> {
  const rows = await db
    .select({ status: loan.status, n: sql<number>`count(*)::int` })
    .from(loan)
    .where(and(liveLoan, visible(viewer)))
    .groupBy(loan.status);
  const out: Record<LoanStatus, number> = { active: 0, overdue: 0, defaulted: 0, written_off: 0, completed: 0 };
  for (const r of rows) out[r.status] = Number(r.n);
  return out;
}

export async function loanKpis(viewer: Viewer): Promise<LoanKpis> {
  const rows = await listLoans(viewer, { status: "open" });
  const now = new Date();
  const [{ n: dueForWriteOff }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(loan)
    .where(and(liveLoan, visible(viewer), eq(loan.status, "defaulted"), sql`${loan.firstDefaultAt} <= ${new Date(now.getTime() - (await getSettings()).loans.writeOffAfterDays * 86_400_000)}`));
  const live = rows.filter((r) => r.status === "active" || r.status === "overdue");
  const defaulted = rows.filter((r) => r.status === "defaulted");
  const flows = (r: LoanListRow) => loanInflows({ ...r, completed: r.lastCompleted });
  const toCome = (r: LoanListRow) => flows(r).reduce((s, f) => s + f.interestCents, 0);
  const stateShare = (r: LoanListRow) => flows(r).reduce((s, f) => s + f.stateShareCents, 0);
  return {
    // Loans still being repaid (active or overdue); defaulted loans are counted separately.
    open: rows.filter((r) => r.status === "active" || r.status === "overdue").length,
    overdue: rows.filter((r) => r.status === "overdue").length,
    defaulted: rows.filter((r) => r.status === "defaulted").length,
    unassigned: rows.filter((r) => (r.status === "active" || r.status === "overdue") && r.officerStaffId === null).length,
    outstandingCents: rows.reduce((s, r) => s + Math.max(0, r.outstandingCents ?? 0), 0),
    outstandingLiveCents: live.reduce((s, r) => s + Math.max(0, r.outstandingCents ?? 0), 0),
    interestToComeCents: live.reduce((s, r) => s + toCome(r), 0),
    stateShareToComeCents: live.reduce((s, r) => s + stateShare(r), 0),
    defaultedOutstandingCents: defaulted.reduce((s, r) => s + Math.max(0, r.outstandingCents ?? 0), 0),
    defaultedInterestToComeCents: defaulted.reduce((s, r) => s + toCome(r), 0),
    dueForWriteOff,
  };
}

export type LoanPaymentRow = {
  txId: string;
  occurredAt: Date;
  role: LinkRole;
  method: string;
  amountCents: number;
  comment: string;
  levyCents: number;
  /** The game's overdue penalty inside this instalment, booked as a late fee. */
  penaltyCents: number;
  recovery: boolean;
};

export type LoanDetail = {
  loan: typeof loan.$inferSelect;
  officerName: string | null;
  payments: LoanPaymentRow[];
  analysis: LoanAnalysis | null;
  events: { id: number; at: Date; kind: string; detail: Record<string, unknown>; staffName: string | null }[];
  collateral: (typeof loanCollateral.$inferSelect)[];
  adjustments: (typeof loanAdjustment.$inferSelect)[];
  cards: { pasteId: string; tab: string; capturedAt: Date; matchHow: string | null; raw: string }[];
  outstandingCents: number | null;
  writeOffEligibleAt: Date | null;
  otherLoans: number;
};

/** Full detail, or null if the loan doesn't exist or the viewer may not see it. */
export async function getLoan(viewer: Viewer, id: string): Promise<LoanDetail | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await db
    .select({ l: loan, officerName: staff.characterName })
    .from(loan)
    .leftJoin(staff, eq(staff.id, loan.officerStaffId))
    .where(eq(loan.id, id));
  // A retired card-only loan (a duplicate or a mistake) is gone from the app; merged ones redirect (page).
  if (!row || row.l.retiredAt || !canSeeLoan(viewer, row.l)) return null;
  const l = row.l;

  const eventStaff = alias(staff, "event_staff");
  const [payments, events, collateral, cards, [{ others }], adjustments] = await Promise.all([
    db
      .select({
        txId: loanPaymentLink.bankTransactionId,
        occurredAt: bankTransaction.occurredAt,
        role: loanPaymentLink.role,
        method: loanPaymentLink.method,
        amountCents: bankTransaction.amountCents,
        comment: bankTransaction.comment,
        levyCents: loanPaymentLink.levyCents,
        penaltyCents: loanPaymentLink.penaltyCents,
        recoveryEntryId: loanPaymentLink.recoveryEntryId,
      })
      .from(loanPaymentLink)
      .innerJoin(bankTransaction, eq(bankTransaction.id, loanPaymentLink.bankTransactionId))
      .where(eq(loanPaymentLink.loanId, id))
      .orderBy(asc(bankTransaction.occurredAt)),
    db
      .select({ id: loanEvent.id, at: loanEvent.at, kind: loanEvent.kind, detail: loanEvent.detail, staffName: eventStaff.characterName })
      .from(loanEvent)
      .leftJoin(eventStaff, eq(eventStaff.id, loanEvent.staffId))
      .where(eq(loanEvent.loanId, id))
      .orderBy(desc(loanEvent.at), desc(loanEvent.id)),
    db.select().from(loanCollateral).where(eq(loanCollateral.loanId, id)).orderBy(asc(loanCollateral.createdAt)),
    db
      .select({ pasteId: loanPaste.id, tab: loanPaste.tab, capturedAt: loanPaste.capturedAt, matchHow: loanCard.matchHow, raw: loanCard.raw })
      .from(loanCard)
      .innerJoin(loanPaste, eq(loanPaste.id, loanCard.pasteId))
      .where(eq(loanCard.loanId, id))
      .orderBy(desc(loanPaste.capturedAt))
      .limit(20),
    db
      .select({ others: sql<number>`count(*)::int` })
      .from(loan)
      .where(and(liveLoan, eq(loan.borrowerStateId, l.borrowerStateId), sql`${loan.id} <> ${id}`)),
    db.select().from(loanAdjustment).where(eq(loanAdjustment.loanId, id)).orderBy(asc(loanAdjustment.createdAt)),
  ]);

  const paymentRows: LoanPaymentRow[] = payments.map((p) => ({
    txId: p.txId,
    occurredAt: p.occurredAt,
    role: p.role as LinkRole,
    method: p.method,
    amountCents: p.amountCents,
    comment: p.comment,
    levyCents: p.levyCents,
    penaltyCents: p.penaltyCents,
    recovery: p.recoveryEntryId !== null,
  }));

  // Default/Overdue/Complete cards don't give the period: weekly, as everywhere else (research/14).
  const hasTerms = l.instalments !== null && l.brokerRateBp !== null && l.stateRateBp !== null && l.openedAt !== null;
  const analysis = hasTerms
    ? analyseLoan(
        {
          principalCents: l.principalCents,
          instalments: l.instalments!,
          periodDays: l.periodDays ?? 7,
          brokerRate: l.brokerRateBp! / 10_000,
          stateRate: l.stateRateBp! / 10_000,
          openedAt: l.openedAt!,
        },
        paymentRows.filter((p) => p.role !== "disbursement" && p.role !== "fee"),
      )
    : null;

  const principalIn = paymentRows
    .filter((p) => p.role === "principal" || p.role === "early_principal" || p.role === "late_principal")
    .reduce((s, p) => s + p.amountCents - p.penaltyCents, 0);
  const levy = paymentRows.reduce((s, p) => s + p.levyCents, 0) + adjustments.reduce((s, a) => s + a.amountCents, 0);

  return {
    loan: l,
    officerName: row.officerName,
    payments: paymentRows,
    analysis,
    events: events.map((e) => ({ ...e, detail: e.detail ?? {} })),
    collateral,
    adjustments,
    cards,
    outstandingCents: l.disbursementTxId && l.status !== "written_off" ? l.principalCents - principalIn - levy : null,
    writeOffEligibleAt: l.status === "defaulted" && l.firstDefaultAt ? writeOffEligibleAt(l.firstDefaultAt, (await getSettings()).loans.writeOffAfterDays) : null,
    otherLoans: others,
  };
}

export type BorrowerSummary = {
  stateId: number;
  name: string | null;
  loans: { id: string | null; principalCents: number; openedAt: Date | null; status: LoanStatus; completedAt: Date | null; mine: boolean }[];
  totals: { count: number; open: number; completed: number; defaulted: number; writtenOff: number; borrowedCents: number };
};

/** Where a card-only loan merged into another went, for redirecting old links (null if not merged). */
export async function mergedLoanInto(id: string): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  let current = id;
  for (let hop = 0; hop < 5; hop++) {
    const [row] = await db.select({ into: loan.mergedIntoId }).from(loan).where(eq(loan.id, current));
    if (!row?.into) return current === id ? null : current;
    current = row.into;
  }
  return current;
}

/**
 * History summary for any borrower (`borrower.lookup`): enough to judge a new
 * application, without payment details of loans the viewer doesn't manage.
 */
export async function borrowerSummary(viewer: Viewer, stateId: number): Promise<BorrowerSummary | null> {
  const rows = await db.select().from(loan).where(and(liveLoan, eq(loan.borrowerStateId, stateId))).orderBy(desc(loan.openedAt));
  if (rows.length === 0) return null;
  return {
    stateId,
    name: rows.find((r) => r.borrowerName)?.borrowerName ?? null,
    loans: rows.map((r) => ({
      id: canSeeLoan(viewer, r) ? r.id : null,
      principalCents: r.principalCents,
      openedAt: r.openedAt,
      status: r.status,
      completedAt: r.completedAt,
      mine: r.officerStaffId === viewer.staffId,
    })),
    totals: {
      count: rows.length,
      open: rows.filter((r) => OPEN.includes(r.status)).length,
      completed: rows.filter((r) => r.status === "completed").length,
      /** Ever defaulted, whatever happened since. */
      defaulted: rows.filter((r) => r.firstDefaultAt !== null || r.status === "defaulted" || r.status === "written_off").length,
      writtenOff: rows.filter((r) => r.status === "written_off").length,
      borrowedCents: rows.reduce((s, r) => s + r.principalCents, 0),
    },
  };
}

/** Borrowers matching a name fragment, for the lookup page. */
/** Borrowers (loans) and mortgage buyers matching a name fragment or State ID, for the lookup page. */
export async function searchBorrowers(q: string): Promise<{ stateId: number; name: string | null; loans: number }[]> {
  const term = cleanSearch(q);
  if (!term) return [];
  const byId = /^\d+$/.test(term);
  if (byId && asStateId(term) === null) return [];
  const like = `%${likeEscape(term)}%`;
  const rows = await db.execute<{ state_id: number; name: string | null; loans: number }>(sql`
    select state_id, max(name) as name, count(*)::int as loans from (
      select borrower_state_id as state_id, borrower_name as name from loan where retired_at is null
      union all
      select buyer_state_id, buyer_name from mortgage where buyer_state_id is not null and merged_into_id is null
    ) p
    where ${byId ? sql`state_id = ${Number(term)}` : sql`name ilike ${like}`}
    group by state_id
    order by max(name)
    limit 25`);
  return rows.rows.map((r) => ({ stateId: Number(r.state_id), name: r.name, loans: Number(r.loans) }));
}

/**
 * People who can be made officer — invited staff included, marked as such. For a
 * finished loan or mortgage (`finished`), former staff too.
 */
/** Who can be a loan's or mortgage's officer. The Legal Team (the outside lawyer, 2026-11-10) never is. */
export async function activeStaffOptions(opts: { finished?: boolean } = {}): Promise<{ id: string; name: string }[]> {
  const rows = await db
    .select({ id: staff.id, name: staff.characterName, status: staff.status })
    .from(staff)
    .where(and(inArray(staff.status, [...(opts.finished ? RECORD_STATUSES : WORKING_STATUSES)]), ne(staff.role, "legal")))
    .orderBy(asc(staff.characterName));
  return rows.map((r) => ({ id: r.id, name: staffOptionLabel(r.name, r.status) }));
}

export { canSeeLoan };
