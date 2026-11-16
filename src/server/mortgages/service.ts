import "server-only";
import { and, count, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { hasAddress, withAlias } from "@/domain/mortgages/identity";
import { looksLikeAddress } from "@/domain/mortgages/parse-tablet";
import { can, ForbiddenError } from "@/lib/permissions";
import { recordAudit } from "@/server/audit/audit";
import { requireFreshStepUp } from "@/server/auth/step-up-guard";
import { canAssignOfficer, canBeOfficer, NOT_OFFICER_MESSAGE } from "@/server/authz/rules";
import type { Viewer } from "@/server/authz/viewer";
import { db } from "@/server/db";
import { loanCollectionAction, mortgage, mortgageEvent, mortgagePayment, mortgageQuote, mortgageSnapshot, staff } from "@/server/db/schema";
import { LoanError } from "@/server/loans/errors";
import { getRequestMeta } from "@/server/request";
import { canSeeMortgage } from "./queries";
import { syncMortgages } from "./sync";
import { RECORD_STATUSES, WORKING_STATUSES } from "@/lib/roles";

/** Hand-made mortgage changes; each is audited and leaves a mortgage event. */

export const assignMortgageOfficerSchema = z.object({
  mortgageId: z.uuid(),
  officerStaffId: z.uuid().nullable(),
  reason: z.string().trim().min(5, "Give a reason (at least 5 characters).").max(300).optional(),
});

/** Management+ may set anyone; an officer may only claim an unassigned mortgage. */
export async function assignMortgageOfficer(viewer: Viewer, raw: z.input<typeof assignMortgageOfficerSchema>): Promise<void> {
  const input = assignMortgageOfficerSchema.parse(raw);
  const request = await getRequestMeta();
  await db.transaction(async (tx) => {
    const [m] = await tx.select().from(mortgage).where(eq(mortgage.id, input.mortgageId)).for("update");
    if (!m) throw new LoanError("Mortgage not found.");
    if (!canAssignOfficer(viewer, m, input.officerStaffId)) {
      throw new ForbiddenError("Loan officers can only claim unassigned mortgages for themselves.");
    }
    if (m.officerStaffId === input.officerStaffId) return;
    if (m.officerStaffId && !input.reason) throw new LoanError("Give a reason for changing the officer.");
    if (input.officerStaffId) {
      const finished = m.status === "completed";
      const statuses = finished ? RECORD_STATUSES : WORKING_STATUSES;
      const [s] = await tx.select({ id: staff.id, role: staff.role }).from(staff).where(and(eq(staff.id, input.officerStaffId), inArray(staff.status, [...statuses])));
      if (!s) throw new LoanError(finished ? "Staff member not found." : "Officers of open mortgages must be current staff (departed staff can be named on completed ones).");
      if (!canBeOfficer(s)) throw new LoanError(NOT_OFFICER_MESSAGE);
    }
    await tx.update(mortgage).set({ officerStaffId: input.officerStaffId, updatedAt: new Date() }).where(eq(mortgage.id, m.id));
    await tx.insert(mortgageEvent).values({
      mortgageId: m.id,
      kind: m.officerStaffId ? "officer_changed" : "officer_assigned",
      staffId: viewer.staffId,
      detail: { from: m.officerStaffId, to: input.officerStaffId, reason: input.reason ?? null },
    });
    await recordAudit(tx, {
      actor: { type: "staff", staffId: viewer.staffId },
      action: "mortgages.officer_assigned",
      target: { type: "mortgage", id: m.id },
      reason: input.reason,
      metadata: { from: m.officerStaffId, to: input.officerStaffId },
      request,
    });
  });
}

export const mergeMortgageSchema = z.object({
  mortgageId: z.uuid(),
  intoId: z.uuid(),
  reason: z.string().trim().min(5, "Give a reason (at least 5 characters).").max(500),
});

/**
 * Retires a duplicate mortgage record into the real one. Sensitive (ADR 0002): fresh
 * step-up and a reason. The duplicate keeps its row and history with `merged_into_id`
 * set, which every query already skips (as for the sync's own merges); its tablet
 * pastes and quote move to the real record.
 *
 * Only a record with no bank money can be merged away: the down payment is what
 * identifies a mortgage, so a record holding money is the real one.
 */
export async function mergeMortgage(viewer: Viewer, raw: z.input<typeof mergeMortgageSchema>): Promise<void> {
  if (!can(viewer.role, "records.merge")) throw new ForbiddenError();
  requireFreshStepUp(viewer);
  const input = mergeMortgageSchema.parse(raw);
  if (input.mortgageId === input.intoId) throw new LoanError("Choose a different mortgage to merge into.");
  const request = await getRequestMeta();

  await db.transaction(async (tx) => {
    const rows = await tx.select().from(mortgage).where(inArray(mortgage.id, [input.mortgageId, input.intoId])).for("update");
    const source = rows.find((r) => r.id === input.mortgageId);
    const target = rows.find((r) => r.id === input.intoId);
    if (!source || source.mergedIntoId) throw new LoanError("Mortgage not found.");
    if (!target || target.mergedIntoId) throw new LoanError("The mortgage to merge into wasn't found.");
    const [{ payments }] = await tx.select({ payments: count() }).from(mortgagePayment).where(eq(mortgagePayment.mortgageId, source.id));
    if (source.originationTxId || source.fundingEntryId || payments > 0) {
      throw new LoanError("This record has bank money linked to it, so it’s the real one. Open the other record and merge that one into this.");
    }
    // The collections log is append-only, so it can't follow the record anywhere.
    const [{ chased }] = await tx.select({ chased: count() }).from(loanCollectionAction).where(eq(loanCollectionAction.mortgageId, source.id));
    if (chased > 0) throw new LoanError("This record has a collections log, so it’s being treated as the real one. Merge the other record into this one instead.");
    const quotes = await tx.select({ id: mortgageQuote.id, number: mortgageQuote.number, mortgageId: mortgageQuote.mortgageId }).from(mortgageQuote).where(inArray(mortgageQuote.mortgageId, [source.id, target.id]));
    const sourceQuote = quotes.find((q) => q.mortgageId === source.id);
    const targetQuote = quotes.find((q) => q.mortgageId === target.id);
    if (sourceQuote && targetQuote) throw new LoanError(`Both records have a quote (#${sourceQuote.number} and #${targetQuote.number}). Unlink the wrong one first.`);

    const now = new Date();
    const snapshots = await tx.update(mortgageSnapshot).set({ mortgageId: target.id }).where(eq(mortgageSnapshot.mortgageId, source.id)).returning({ id: mortgageSnapshot.id });
    if (sourceQuote) await tx.update(mortgageQuote).set({ mortgageId: target.id, updatedAt: now }).where(eq(mortgageQuote.id, sourceQuote.id));
    // A real former address helps link repayments made under it; a stray heading must not.
    let aliases = target.addressAliases;
    for (const a of [source.address, ...source.addressAliases]) {
      if (looksLikeAddress(a) && !hasAddress({ address: target.address, addressAliases: aliases }, a)) aliases = withAlias(aliases, target.address, a);
    }
    await tx.update(mortgage).set({ addressAliases: aliases, updatedAt: now }).where(eq(mortgage.id, target.id));
    await tx.update(mortgage).set({ mergedIntoId: target.id, updatedAt: now }).where(eq(mortgage.id, source.id));
    await tx.insert(mortgageEvent).values([
      { mortgageId: target.id, at: now, kind: "merged", staffId: viewer.staffId, detail: { fromAddress: source.address, mergedId: source.id, reason: input.reason } },
      { mortgageId: source.id, at: now, kind: "merged_into", staffId: viewer.staffId, detail: { intoAddress: target.address, intoId: target.id, reason: input.reason } },
    ]);
    await recordAudit(tx, {
      actor: { type: "staff", staffId: viewer.staffId },
      action: "mortgages.merged",
      target: { type: "mortgage", id: source.id },
      reason: input.reason,
      metadata: {
        address: source.address,
        buyerStateId: source.buyerStateId,
        intoId: target.id,
        intoAddress: target.address,
        snapshotsMoved: snapshots.length,
        quoteMoved: sourceQuote?.number ?? null,
      },
      request,
    });
    // A former address added above may let repayments link.
    await syncMortgages(tx);
  });
}

export const mortgageNoteSchema = z.object({ mortgageId: z.uuid(), text: z.string().trim().min(1, "Write a note.").max(2000) });

export async function addMortgageNote(viewer: Viewer, raw: z.input<typeof mortgageNoteSchema>): Promise<void> {
  const input = mortgageNoteSchema.parse(raw);
  const [m] = await db.select().from(mortgage).where(eq(mortgage.id, input.mortgageId));
  if (!m || !canSeeMortgage(viewer, m)) throw new LoanError("Mortgage not found.");
  const request = await getRequestMeta();
  await db.transaction(async (tx) => {
    const [e] = await tx.insert(mortgageEvent).values({ mortgageId: m.id, kind: "note", staffId: viewer.staffId, detail: { text: input.text } }).returning({ id: mortgageEvent.id });
    await recordAudit(tx, {
      actor: { type: "staff", staffId: viewer.staffId },
      action: "mortgages.note_added",
      target: { type: "mortgage", id: m.id },
      metadata: { eventId: e.id, length: input.text.length },
      request,
    });
  });
}
