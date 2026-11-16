import "server-only";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { approvalApplies, approvalFlag, mortgageApproval, type ApprovalEvidence } from "@/domain/mortgages/approval";
import type { GuidelineFlag } from "@/domain/mortgages/schedule";
import { quoteDifferences, quoteMortgage } from "@/domain/origination/mortgage-quote";
import { LIVE_QUOTE_STATUSES } from "@/domain/origination/quote-status";
import type { Settings } from "@/domain/settings";
import { can, ForbiddenError } from "@/lib/permissions";
import { isExecutive } from "@/lib/roles";
import { recordAudit } from "@/server/audit/audit";
import type { Viewer } from "@/server/authz/viewer";
import { db, type Tx } from "@/server/db";
import { mortgage, mortgageEvent, mortgageQuote, staff } from "@/server/db/schema";
import { LoanError } from "@/server/loans/errors";
import { getRequestMeta } from "@/server/request";
import { getSettings } from "@/server/settings";
import { inputOf } from "@/server/origination/mortgage-quotes";

/**
 * Executive approval of large mortgages (research/18), from the records: the officer's role, the
 * quote the mortgage was made from, and any approval given after the fact (a `mortgage_event`, so
 * it's kept with the mortgage's history). The rule itself is `domain/mortgages/approval.ts`.
 */

type Row = typeof mortgage.$inferSelect;
type Executor = typeof db | Tx;
const approver = alias(staff, "approver");

export const APPROVED_AFTER_EVENT = "executive_approved";

/** Evidence for the mortgages the rule covers (others aren't in the map). */
export async function approvalEvidence(rows: Row[], g: Settings["mortgages"], executor: Executor = db): Promise<Map<string, ApprovalEvidence>> {
  const covered = rows.filter((m) => approvalApplies(m, g));
  const out = new Map<string, ApprovalEvidence>();
  if (!covered.length) return out;
  const ids = covered.map((m) => m.id);
  const officerIds = [...new Set(covered.flatMap((m) => (m.officerStaffId ? [m.officerStaffId] : [])))];
  const roles = officerIds.length ? await executor.select({ id: staff.id, role: staff.role }).from(staff).where(inArray(staff.id, officerIds)) : [];
  const quotes = (
    await executor
      .select({ q: mortgageQuote, approvedByName: approver.characterName })
      .from(mortgageQuote)
      .leftJoin(approver, eq(approver.id, mortgageQuote.approvedByStaffId))
      .where(inArray(mortgageQuote.mortgageId, ids))
  ).map((r) => ({ ...r.q, approvedByName: r.approvedByName }));
  const events = await executor
    .select({ mortgageId: mortgageEvent.mortgageId, at: mortgageEvent.at, byName: staff.characterName })
    .from(mortgageEvent)
    .leftJoin(staff, eq(staff.id, mortgageEvent.staffId))
    .where(and(inArray(mortgageEvent.mortgageId, ids), eq(mortgageEvent.kind, APPROVED_AFTER_EVENT)))
    .orderBy(desc(mortgageEvent.at));
  const roleOf = new Map(roles.map((r) => [r.id, r.role]));
  for (const m of covered) {
    const q = quotes.find((x) => x.mortgageId === m.id);
    const ev = events.find((e) => e.mortgageId === m.id);
    const role = m.officerStaffId ? roleOf.get(m.officerStaffId) : undefined;
    out.set(m.id, {
      officerIsExecutive: role !== undefined && isExecutive(role),
      quote: q
        ? {
            number: q.number,
            approvedAt: q.approvedAt,
            approvedByName: q.approvedByName,
            differences: quoteDifferences({ ...quoteMortgage(inputOf(q)), brokerRateBp: q.brokerRateBp, fedRateBp: q.fedRateBp }, m),
          }
        : null,
      approvedAfter: ev ? { at: ev.at, byName: ev.byName } : null,
    });
  }
  return out;
}

/** The "not approved" flag for each mortgage that has one. */
export async function approvalFlags(rows: Row[], g: Settings["mortgages"], executor: Executor = db): Promise<Map<string, GuidelineFlag>> {
  const evidence = await approvalEvidence(rows, g, executor);
  const out = new Map<string, GuidelineFlag>();
  for (const m of rows) {
    const e = evidence.get(m.id);
    const flag = e ? approvalFlag(m, e, g) : null;
    if (flag) out.set(m.id, flag);
  }
  return out;
}

/** Every live mortgage the rule covers that no executive approved — for the executives' bell. */
export async function unapprovedMortgages(): Promise<{ m: Row; officer: string | null; flag: GuidelineFlag }[]> {
  const g = (await getSettings()).mortgages;
  const found = (
    await db.select({ m: mortgage, staffName: staff.characterName }).from(mortgage).leftJoin(staff, eq(staff.id, mortgage.officerStaffId)).where(isNull(mortgage.mergedIntoId))
  ).filter((r) => approvalApplies(r.m, g));
  const flags = await approvalFlags(
    found.map((r) => r.m),
    g,
  );
  // The officer on record, else the name typed on the tablet.
  return found.flatMap((r) => (flags.has(r.m.id) ? [{ m: r.m, officer: r.staffName ?? r.m.officerName, flag: flags.get(r.m.id)! }] : []));
}

export const approveMortgageSchema = z.object({ mortgageId: z.uuid(), reason: z.string().trim().min(5, "Give a reason (at least 5 characters).").max(500) });

/** An executive approves a mortgage that went on the tablet without an approved quote. */
export async function approveMortgageAfter(viewer: Viewer, raw: z.input<typeof approveMortgageSchema>): Promise<void> {
  const { mortgageId, reason } = approveMortgageSchema.parse(raw);
  if (!can(viewer.role, "mortgages.approve_large")) throw new ForbiddenError("Only an executive can approve a large mortgage.");
  const g = (await getSettings()).mortgages;
  const request = await getRequestMeta();
  await db.transaction(async (tx) => {
    const [m] = await tx.select().from(mortgage).where(and(eq(mortgage.id, mortgageId), isNull(mortgage.mergedIntoId))).for("update");
    if (!m) throw new LoanError("Mortgage not found.");
    const e = (await approvalEvidence([m], g, tx)).get(m.id);
    const state = e ? mortgageApproval(m, e, g) : { required: false as const };
    if (!state.required) throw new LoanError("This mortgage doesn’t need an executive’s approval.");
    if (state.approved) throw new LoanError("This mortgage is already approved.");
    await tx.insert(mortgageEvent).values({ mortgageId, kind: APPROVED_AFTER_EVENT, staffId: viewer.staffId, detail: { reason } });
    await recordAudit(tx, {
      actor: { type: "staff", staffId: viewer.staffId },
      action: "mortgages.approved_after",
      target: { type: "mortgage", id: mortgageId },
      reason,
      metadata: { address: m.address, buyerStateId: m.buyerStateId, baseCents: (m.downPaymentCents ?? 0) + (m.loanCents ?? 0) },
      request,
    });
  });
}

/**
 * The approval flag for a pasted agreement before it's saved (tablet preview): the quote it will be
 * linked to is the one already linked to its mortgage, or else the buyer's open quote with the same
 * loan or address (as `matchQuotes` will pick).
 */
export async function previewApprovalFlag(
  t: {
    address: string;
    buyerStateId: number | null;
    officerStaffId: string | null;
    downPaymentCents: number | null;
    loanCents: number | null;
    brokerFeeCents: number | null;
    brokerRateBp: number | null;
    fedRateBp: number | null;
    instalments: number | null;
  },
  existing: Row | null,
  g: Settings["mortgages"],
): Promise<GuidelineFlag | null> {
  const m = { ...t, originatedAt: existing?.originatedAt ?? null };
  if (!approvalApplies(m, g)) return null;
  const officerId = existing?.officerStaffId ?? t.officerStaffId;
  const [officer] = officerId ? await db.select({ role: staff.role }).from(staff).where(eq(staff.id, officerId)) : [];
  let [q] = existing ? await db.select().from(mortgageQuote).where(eq(mortgageQuote.mortgageId, existing.id)) : [];
  if (!q && t.buyerStateId !== null) {
    const open = await db
      .select()
      .from(mortgageQuote)
      .where(and(inArray(mortgageQuote.status, [...LIVE_QUOTE_STATUSES]), eq(mortgageQuote.buyerStateId, t.buyerStateId)))
      .orderBy(mortgageQuote.createdAt);
    q = open.find((o) => quoteMortgage(inputOf(o)).loanCents === t.loanCents || o.address.toLowerCase() === t.address.toLowerCase()) as typeof q;
  }
  const [ev] = existing
    ? await db
        .select({ at: mortgageEvent.at, byName: staff.characterName })
        .from(mortgageEvent)
        .leftJoin(staff, eq(staff.id, mortgageEvent.staffId))
        .where(and(eq(mortgageEvent.mortgageId, existing.id), eq(mortgageEvent.kind, APPROVED_AFTER_EVENT)))
    : [];
  return approvalFlag(
    m,
    {
      officerIsExecutive: officer !== undefined && isExecutive(officer.role),
      quote: q ? { number: q.number, approvedAt: q.approvedAt, differences: quoteDifferences({ ...quoteMortgage(inputOf(q)), brokerRateBp: q.brokerRateBp, fedRateBp: q.fedRateBp }, t) } : null,
      approvedAfter: ev ? { at: ev.at, byName: ev.byName } : null,
    },
    g,
  );
}
