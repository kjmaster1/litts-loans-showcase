import "server-only";
import { canSeeMortgage, officerScope, viewerOf, type ListScope } from "@/server/authz/rules";
import { and, desc, eq, ilike, isNull, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { mortgageApproval, approvalFlag, type ApprovalEvidence, type MortgageApproval } from "@/domain/mortgages/approval";
import { analyseMortgage, mortgageGuidelines, type GuidelineFlag, type MortgageAnalysis, type MortgagePayment } from "@/domain/mortgages/schedule";
import { can } from "@/lib/permissions";
import { asStateId, cleanSearch, likeEscape } from "@/lib/search";
import type { Viewer } from "@/server/authz/viewer";
import { db } from "@/server/db";
import { approvalEvidence, approvalFlags } from "./approval";
import { paymentsByMortgage } from "./payments";
import { bankTransaction, mortgage, mortgageEvent, mortgagePaste, mortgagePayment, mortgageSettlement, mortgageSnapshot, staff } from "@/server/db/schema";
import { getSettings } from "@/server/settings";

/** Read models for the mortgage pages. Visibility as for loans (SPEC §2). */

export const MORTGAGE_FILTERS = ["active", "behind", "completed", "unpasted", "all"] as const;
export type MortgageFilter = (typeof MORTGAGE_FILTERS)[number];

type Row = typeof mortgage.$inferSelect;

/** The mortgages `viewer` may see in full (authz/rules). */
const visible = (viewer: Viewer): SQL | undefined => officerScope(viewer, mortgage.officerStaffId);

const outTx = alias(bankTransaction, "out_tx");

export function hasTerms(m: Row): boolean {
  // Company-funded mortgages have no federal interest (the State isn't lending).
  const federalKnown = m.federalInterestCents !== null || m.funding === "company";
  return m.loanCents !== null && m.instalments !== null && m.originatedAt !== null && m.brokerInterestCents !== null && federalKnown;
}

export function analysisFor(m: Row, payments: MortgagePayment[], now = new Date()): MortgageAnalysis | null {
  if (!hasTerms(m)) return null;
  return analyseMortgage(
    {
      loanCents: m.loanCents!,
      brokerInterestCents: m.brokerInterestCents!,
      federalInterestCents: m.federalInterestCents ?? 0,
      instalments: m.instalments!,
      originatedAt: m.originatedAt!,
      gracePeriodDays: m.gracePeriodDays ?? 7,
    },
    payments,
    now,
  );
}

export type MortgageListRow = {
  id: string;
  address: string;
  buyerName: string | null;
  buyerStateId: number | null;
  priceCents: number | null;
  loanCents: number | null;
  instalments: number | null;
  paymentsMade: number;
  officerStaffId: string | null;
  officerName: string | null;
  originatedAt: Date | null;
  status: Row["status"];
  funding: Row["funding"];
  pasted: boolean;
  state: MortgageAnalysis["state"] | null;
  brokerInterestRemainingCents: number | null;
  principalRemainingCents: number | null;
  flags: GuidelineFlag[];
};

async function loadRows(viewer: Viewer | null, extra?: SQL) {
  return db
    .select({ m: mortgage, officerName: staff.characterName })
    .from(mortgage)
    .leftJoin(staff, eq(staff.id, mortgage.officerStaffId))
    .where(and(isNull(mortgage.mergedIntoId), viewer ? visible(viewer) : undefined, extra))
    .orderBy(desc(mortgage.originatedAt), desc(mortgage.createdAt));
}

export async function listMortgages(
  /** A viewer (their mortgages), or SERVER_AGGREGATE for every mortgage — server-side figures only. */
  scope: ListScope,
  filter: { status?: MortgageFilter; q?: string } = {},
): Promise<MortgageListRow[]> {
  const viewer = viewerOf(scope);
  const q = cleanSearch(filter.q);
  const id = asStateId(q);
  // The current address or a former one (the server renumbers houses).
  const addressLike = (pattern: string) =>
    or(ilike(mortgage.address, pattern), sql`exists (select 1 from unnest(${mortgage.addressAliases}) a where a ilike ${pattern})`);
  const search = q
    ? /^\d+$/.test(q)
      ? // A number is a buyer's State ID or a house number.
        id === null
        ? addressLike(`${q}%`)
        : or(eq(mortgage.buyerStateId, id), addressLike(`${q}%`))
      : or(addressLike(`%${likeEscape(q)}%`), ilike(mortgage.buyerName, `%${likeEscape(q)}%`))
    : undefined;
  const rows = await loadRows(viewer, search);
  const all = await db.select({ id: mortgage.id, buyerStateId: mortgage.buyerStateId, address: mortgage.address }).from(mortgage).where(isNull(mortgage.mergedIntoId));
  const payments = await paymentsByMortgage(rows.map((r) => r.m.id));
  const now = new Date();
  const settings = await getSettings();
  const unapproved = await approvalFlags(rows.map((r) => r.m), settings.mortgages);

  const list = rows.map(({ m, officerName }) => {
    const p = payments.get(m.id) ?? [];
    const a = analysisFor(m, p, now);
    const other = all.some((o) => o.id !== m.id && m.buyerStateId !== null && o.buyerStateId === m.buyerStateId && o.address !== m.address);
    return {
      id: m.id,
      address: m.address,
      buyerName: m.buyerName,
      buyerStateId: m.buyerStateId,
      priceCents: m.priceCents,
      loanCents: m.loanCents,
      instalments: m.instalments,
      paymentsMade: p.length,
      officerStaffId: m.officerStaffId,
      officerName,
      originatedAt: m.originatedAt,
      status: m.status,
      funding: m.funding,
      pasted: m.lastTabletAt !== null,
      state: a?.state ?? null,
      brokerInterestRemainingCents: a?.brokerInterestRemainingCents ?? null,
      principalRemainingCents: a?.principalRemainingCents ?? null,
      flags: [
        ...(unapproved.has(m.id) ? [unapproved.get(m.id)!] : []),
        ...mortgageGuidelines(m, { buyerHasOtherMortgage: other, funding: m.funding, originatedAt: m.originatedAt }, settings.mortgages),
      ],
    };
  });

  switch (filter.status ?? "active") {
    case "active":
      return list.filter((r) => r.status === "active");
    case "behind":
      return list.filter((r) => r.status === "active" && (r.state?.kind === "behind" || r.state?.kind === "late"));
    case "completed":
      return list.filter((r) => r.status === "completed");
    case "unpasted":
      return list.filter((r) => !r.pasted);
    case "all":
      return list;
  }
}

export type MortgageKpis = {
  active: number;
  behind: number;
  late: number;
  unpasted: number;
  completed: number;
  /** Every mortgage the viewer may see (the "All" tab). */
  total: number;
  owedToStateCents: number;
  /** Principal Litt's lent from its own money, still to come back. */
  owedToCompanyCents: number;
  brokerInterestToComeCents: number;
  unlinkedRepayments: number;
};

export async function mortgageKpis(viewer: Viewer): Promise<MortgageKpis> {
  const rows = await listMortgages(viewer, { status: "all" });
  const active = rows.filter((r) => r.status === "active");
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(bankTransaction)
    .leftJoin(mortgagePayment, eq(mortgagePayment.bankTransactionId, bankTransaction.id))
    .where(and(eq(bankTransaction.category, "mortgage.repayment_in"), isNull(mortgagePayment.bankTransactionId)));
  return {
    active: active.length,
    behind: active.filter((r) => r.state?.kind === "behind").length,
    late: active.filter((r) => r.state?.kind === "late").length,
    unpasted: rows.filter((r) => !r.pasted).length,
    completed: rows.filter((r) => r.status === "completed").length,
    total: rows.length,
    owedToStateCents: active.filter((r) => r.funding === "state").reduce((s, r) => s + (r.principalRemainingCents ?? 0), 0),
    owedToCompanyCents: active.filter((r) => r.funding === "company").reduce((s, r) => s + (r.principalRemainingCents ?? 0), 0),
    brokerInterestToComeCents: active.reduce((s, r) => s + (r.brokerInterestRemainingCents ?? 0), 0),
    unlinkedRepayments: can(viewer.role, "loans.view_all") ? n : 0,
  };
}

export type MortgageDetail = {
  mortgage: Row;
  officerName: string | null;
  analysis: MortgageAnalysis | null;
  payments: MortgagePayment[];
  origination: { inCents: number; taxCents: number; outCents: number | null; at: Date } | null;
  flags: GuidelineFlag[];
  /** Executive approval (research/18), with what showed it. */
  approval: MortgageApproval;
  approvalEvidence: ApprovalEvidence | null;
  events: { id: number; at: Date; kind: string; detail: Record<string, unknown>; staffName: string | null }[];
  snapshots: { id: number; capturedAt: Date; raw: string }[];
  otherMortgages: { id: string; address: string; status: Row["status"] }[];
};

export async function getMortgage(viewer: Viewer, id: string): Promise<MortgageDetail | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await db.select({ m: mortgage, officerName: staff.characterName }).from(mortgage).leftJoin(staff, eq(staff.id, mortgage.officerStaffId)).where(eq(mortgage.id, id));
  if (!row || row.m.mergedIntoId || !canSeeMortgage(viewer, row.m)) return null;
  const m = row.m;
  const eventStaff = alias(staff, "event_staff");

  const [payments, origination, events, snapshots, others] = await Promise.all([
    paymentsByMortgage([id]).then((p) => p.get(id) ?? []),
    m.originationTxId
      ? db
          .select({ inCents: bankTransaction.amountCents, taxCents: bankTransaction.taxCents, outCents: outTx.amountCents, at: bankTransaction.occurredAt })
          .from(bankTransaction)
          .leftJoin(mortgageSettlement, and(eq(mortgageSettlement.inTxId, bankTransaction.id), isNull(mortgageSettlement.unwoundAt)))
          .leftJoin(outTx, eq(outTx.id, mortgageSettlement.outTxId))
          .where(eq(bankTransaction.id, m.originationTxId))
          .then((r) => r[0] ?? null)
      : Promise.resolve(null),
    db
      .select({ id: mortgageEvent.id, at: mortgageEvent.at, kind: mortgageEvent.kind, detail: mortgageEvent.detail, staffName: eventStaff.characterName })
      .from(mortgageEvent)
      .leftJoin(eventStaff, eq(eventStaff.id, mortgageEvent.staffId))
      .where(eq(mortgageEvent.mortgageId, id))
      .orderBy(desc(mortgageEvent.at), desc(mortgageEvent.id)),
    db
      .select({ id: mortgageSnapshot.id, capturedAt: mortgagePaste.capturedAt, raw: mortgageSnapshot.raw })
      .from(mortgageSnapshot)
      .innerJoin(mortgagePaste, eq(mortgagePaste.id, mortgageSnapshot.pasteId))
      .where(eq(mortgageSnapshot.mortgageId, id))
      .orderBy(desc(mortgagePaste.capturedAt))
      .limit(10),
    m.buyerStateId !== null
      ? db
          .select({ id: mortgage.id, address: mortgage.address, status: mortgage.status })
          .from(mortgage)
          .where(and(eq(mortgage.buyerStateId, m.buyerStateId), isNull(mortgage.mergedIntoId), sql`${mortgage.id} <> ${id}`))
      : Promise.resolve([]),
  ]);

  const g = (await getSettings()).mortgages;
  const evidence = (await approvalEvidence([m], g)).get(m.id) ?? null;
  const unapproved = evidence ? approvalFlag(m, evidence, g) : null;
  return {
    mortgage: m,
    officerName: row.officerName,
    analysis: analysisFor(m, payments),
    payments,
    origination: origination ? { ...origination, outCents: origination.outCents ?? null } : null,
    flags: [...(unapproved ? [unapproved] : []), ...mortgageGuidelines(m, { buyerHasOtherMortgage: others.some((o) => o.address !== m.address), funding: m.funding, originatedAt: m.originatedAt }, g)],
    approval: evidence ? mortgageApproval(m, evidence, g) : { required: false },
    approvalEvidence: evidence,
    events: events.map((e) => ({ ...e, detail: e.detail ?? {} })),
    snapshots,
    otherMortgages: others,
  };
}

/** Where a merged record went, for redirecting old links (null if it wasn't merged or doesn't exist). */
export async function mergedInto(id: string): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  // Follow a chain (a record merged into one that was later merged too), at most a few hops.
  let current = id;
  for (let hop = 0; hop < 5; hop++) {
    const [row] = await db.select({ into: mortgage.mergedIntoId }).from(mortgage).where(eq(mortgage.id, current));
    if (!row?.into) return current === id ? null : current;
    current = row.into;
  }
  return current;
}

export type MergeTarget = { id: string; address: string; buyerName: string | null; buyerStateId: number | null; originatedAt: Date | null; sameBuyer: boolean };

/** Mortgages a duplicate may be merged into: the same buyer's first, then the rest, newest first. */
export async function mergeTargets(m: Row): Promise<MergeTarget[]> {
  const rows = await db
    .select({ id: mortgage.id, address: mortgage.address, buyerName: mortgage.buyerName, buyerStateId: mortgage.buyerStateId, originatedAt: mortgage.originatedAt })
    .from(mortgage)
    .where(and(isNull(mortgage.mergedIntoId), sql`${mortgage.id} <> ${m.id}`))
    .orderBy(desc(mortgage.originatedAt), desc(mortgage.createdAt))
    .limit(300);
  const list = rows.map((r) => ({ ...r, sameBuyer: m.buyerStateId !== null && r.buyerStateId === m.buyerStateId }));
  return [...list.filter((r) => r.sameBuyer), ...list.filter((r) => !r.sameBuyer)];
}

/** For the borrower lookup: a buyer's mortgages, summary only. */
export async function mortgagesForBuyer(stateId: number) {
  return db
    .select({ id: mortgage.id, address: mortgage.address, loanCents: mortgage.loanCents, originatedAt: mortgage.originatedAt, status: mortgage.status, officerStaffId: mortgage.officerStaffId })
    .from(mortgage)
    .where(and(eq(mortgage.buyerStateId, stateId), isNull(mortgage.mergedIntoId)))
    .orderBy(desc(mortgage.originatedAt));
}

export { canSeeMortgage };
