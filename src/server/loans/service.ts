import { dateFormat, formatCents } from "@/lib/format";
import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { writeOffEligibleAt } from "@/domain/loans/status";
import { can, ForbiddenError } from "@/lib/permissions";
import { recordAudit } from "@/server/audit/audit";
import { requireFreshStepUp } from "@/server/auth/step-up-guard";
import { canAnnotateLoan, canAssignOfficer, canBeOfficer, NOT_OFFICER_MESSAGE } from "@/server/authz/rules";
import type { Viewer } from "@/server/authz/viewer";
import { db } from "@/server/db";
import { journalEntry, journalLine, liveLoan, loan, loanCard, loanCollateral, loanEvent, loanOffer, staff } from "@/server/db/schema";
import { getRequestMeta } from "@/server/request";
import { LoanError } from "./errors";
import { outstandingByLoan, syncLoans } from "./sync";
import { RECORD_STATUSES, WORKING_STATUSES } from "@/lib/roles";
import { getSettings } from "@/server/settings";

/** Loan changes made by hand. Every one is audited and leaves a loan event. */

/** "6 Nov 2026, 14:00 GMT": company time, as staff read it (lib/format rules). */
const LONDON_TIME = dateFormat({ day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London", timeZoneName: "short" });

const reason = z.string().trim().min(5, "Give a reason (at least 5 characters).").max(500);

export const writeOffSchema = z.object({ loanId: z.uuid(), reason });

/**
 * Charges off what's still owed on a defaulted loan (docs/design/LOANS.md):
 * Dr 5300 Credit losses / Cr 1100 Loans receivable. Sensitive (ADR 0002):
 * needs a fresh step-up and a reason. Money received afterwards is posted as
 * a recovery by the loan sync.
 */
export async function writeOffLoan(viewer: Viewer, raw: z.input<typeof writeOffSchema>): Promise<{ entryId: string; amountCents: number }> {
  if (!can(viewer.role, "loans.charge_off")) throw new ForbiddenError();
  requireFreshStepUp(viewer);
  const input = writeOffSchema.parse(raw);
  const request = await getRequestMeta();

  return db.transaction(async (tx) => {
    const [l] = await tx.select().from(loan).where(and(liveLoan, eq(loan.id, input.loanId))).for("update");
    if (!l) throw new LoanError("Loan not found.");
    if (l.status !== "defaulted") throw new LoanError("Only defaulted loans can be written off.");
    const eligibleAt = l.firstDefaultAt ? writeOffEligibleAt(l.firstDefaultAt, (await getSettings(tx)).loans.writeOffAfterDays) : null;
    if (!eligibleAt || eligibleAt > new Date()) {
      throw new LoanError(`This loan can be written off from ${eligibleAt ? LONDON_TIME.format(eligibleAt) : "28 days after it defaults"}.`);
    }
    const o = (await outstandingByLoan(tx, [l.id])).get(l.id) ?? { returnedCents: 0, levyCents: 0, adjustedCents: 0 };
    const amount = l.disbursementTxId ? l.principalCents - o.returnedCents - o.levyCents - o.adjustedCents : 0;
    if (amount <= 0) throw new LoanError("Nothing is outstanding on this loan in the books.");

    const now = new Date();
    const entryId = randomUUID();
    await tx.insert(journalEntry).values({
      id: entryId,
      effectiveAt: now,
      kind: "adjustment",
      description: `Write-off — loan to ${l.borrowerName ?? `State ID ${l.borrowerStateId}`}`,
      createdByStaffId: viewer.staffId,
      reason: input.reason,
    });
    await tx.insert(journalLine).values([
      { entryId, accountCode: "5300", debitCents: amount, creditCents: 0, memo: "Loan written off" },
      { entryId, accountCode: "1100", debitCents: 0, creditCents: amount, memo: "Loan written off" },
    ]);
    await tx
      .update(loan)
      .set({ status: "written_off", writtenOffAt: now, writeOffEntryId: entryId, updatedAt: now })
      .where(eq(loan.id, l.id));
    await tx.insert(loanEvent).values({ loanId: l.id, at: now, kind: "written_off", staffId: viewer.staffId, detail: { amountCents: amount, reason: input.reason } });
    await recordAudit(tx, {
      actor: { type: "staff", staffId: viewer.staffId },
      action: "loans.written_off",
      target: { type: "loan", id: l.id },
      reason: input.reason,
      metadata: { amountCents: amount, borrowerStateId: l.borrowerStateId, journalEntryId: entryId },
      request,
    });
    return { entryId, amountCents: amount };
  });
}

export const retireCardOnlyLoanSchema = z.object({ loanId: z.uuid(), intoLoanId: z.uuid().nullable(), reason });

/**
 * Retires a card-only loan (known only from a phone card — no bank disbursement) that
 * shouldn't exist (2026-10-12 data-quality review). Sensitive (ADR 0002): step-up + reason.
 *  - Into another loan: it duplicates one of the same borrower's loans. Its phone cards,
 *    collateral and offer move there.
 *  - Into nothing: added by mistake.
 * The record stays, with `retired_at` set: every query skips it (`liveLoan`) and its history
 * (append-only) is kept. Anything with money, a write-off or a collections log is refused —
 * the database also only lets a loan without a disbursement be retired.
 */
export async function retireCardOnlyLoan(viewer: Viewer, raw: z.input<typeof retireCardOnlyLoanSchema>): Promise<{ intoLoanId: string | null }> {
  if (!can(viewer.role, "records.merge")) throw new ForbiddenError();
  requireFreshStepUp(viewer);
  const input = retireCardOnlyLoanSchema.parse(raw);
  if (input.intoLoanId === input.loanId) throw new LoanError("Choose a different loan to merge into.");
  const request = await getRequestMeta();

  return db.transaction(async (tx) => {
    const [l] = await tx.select().from(loan).where(and(eq(loan.id, input.loanId), liveLoan)).for("update");
    if (!l) throw new LoanError("Loan not found.");
    if (l.disbursementTxId) throw new LoanError("This loan has its bank disbursement, so it’s real. Only a loan known just from phone cards can be retired.");
    if (l.writeOffEntryId || l.status === "written_off") throw new LoanError("This loan was written off, so it has entries in the books and can’t be retired.");
    const [refs] = (
      await tx.execute<{ links: number; adjustments: number; commission: number; collateral: number; collections: number; offers: number }>(sql`
        select (select count(*) from loan_payment_link where loan_id = ${l.id})::int as links,
               (select count(*) from loan_adjustment where loan_id = ${l.id})::int as adjustments,
               (select count(*) from commission_line where loan_id = ${l.id})::int as commission,
               (select count(*) from loan_collateral where loan_id = ${l.id})::int as collateral,
               (select count(*) from loan_collection_action where loan_id = ${l.id})::int as collections,
               (select count(*) from loan_offer where loan_id = ${l.id})::int as offers`)
    ).rows;
    if (refs.links || refs.adjustments || refs.commission) throw new LoanError("This loan has money in the books, so it can’t be retired.");
    // The collections log is append-only, so it can't follow the loan anywhere.
    if (refs.collections) throw new LoanError("This loan has a collections log, so it’s being treated as real. It can’t be retired.");

    let target: typeof loan.$inferSelect | undefined;
    if (input.intoLoanId) {
      [target] = await tx.select().from(loan).where(and(eq(loan.id, input.intoLoanId), liveLoan)).for("update");
      if (!target) throw new LoanError("The loan to merge into wasn’t found.");
      if (target.borrowerStateId !== l.borrowerStateId) throw new LoanError("Choose one of the same borrower’s loans.");
    } else if (refs.collateral || refs.offers) {
      throw new LoanError("This loan has collateral or a loan offer recorded against it. Merge it into the loan they belong to instead.");
    }

    const now = new Date();
    let cardsMoved = 0;
    if (target) {
      cardsMoved = (await tx.update(loanCard).set({ loanId: target.id }).where(eq(loanCard.loanId, l.id)).returning({ id: loanCard.id })).length;
      await tx.update(loanCollateral).set({ loanId: target.id, updatedAt: now }).where(eq(loanCollateral.loanId, l.id));
      await tx.update(loanOffer).set({ loanId: target.id, updatedAt: now }).where(eq(loanOffer.loanId, l.id));
      await tx.insert(loanEvent).values({
        loanId: target.id,
        at: now,
        kind: "merged",
        staffId: viewer.staffId,
        detail: { fromLoanId: l.id, principalCents: l.principalCents, reason: input.reason },
      });
    }
    await tx.update(loan).set({ retiredAt: now, mergedIntoId: target?.id ?? null, nextPaymentDueAt: null, updatedAt: now }).where(eq(loan.id, l.id));
    await tx.insert(loanEvent).values({
      loanId: l.id,
      at: now,
      kind: target ? "merged_into" : "retired",
      staffId: viewer.staffId,
      detail: { intoLoanId: target?.id ?? null, reason: input.reason },
    });
    await recordAudit(tx, {
      actor: { type: "staff", staffId: viewer.staffId },
      action: target ? "loans.card_only.merged" : "loans.card_only.retired",
      target: { type: "loan", id: l.id },
      reason: input.reason,
      metadata: { borrowerStateId: l.borrowerStateId, principalCents: l.principalCents, intoLoanId: target?.id ?? null, cardsMoved },
      request,
    });
    return { intoLoanId: target?.id ?? null };
  });
}

export const markRepaidSchema = z.object({ loanId: z.uuid(), reason });

/** How much can still be "owed" on the books for a loan to be marked repaid (rounding, the State's cut). */
export const REPAID_TOLERANCE_CENTS = 10_000;

/**
 * For the game bug where a loan that was paid off stays in the Default (or
 * Overdue) tab. Allowed only when the books show it repaid; anything more
 * owed is a real loss and should be written off. Locks the status so later
 * pastes don't move it back. Management+, with a fresh step-up (review 2026-10-13):
 * completion books up to REPAID_TOLERANCE_CENTS of what's left as a loss, like a small write-off.
 */
export async function markRepaid(viewer: Viewer, raw: z.input<typeof markRepaidSchema>): Promise<void> {
  if (!can(viewer.role, "loans.edit_metadata")) throw new ForbiddenError();
  requireFreshStepUp(viewer);
  const input = markRepaidSchema.parse(raw);
  const request = await getRequestMeta();

  await db.transaction(async (tx) => {
    const [l] = await tx.select().from(loan).where(and(liveLoan, eq(loan.id, input.loanId))).for("update");
    if (!l) throw new LoanError("Loan not found.");
    if (!["active", "overdue", "defaulted"].includes(l.status)) throw new LoanError("Only an open loan can be marked as repaid.");
    if (!l.disbursementTxId) throw new LoanError("This loan has no bank record to check repayment against.");
    const o = (await outstandingByLoan(tx, [l.id])).get(l.id) ?? { returnedCents: 0, levyCents: 0, adjustedCents: 0 };
    const owed = l.principalCents - o.returnedCents - o.levyCents - o.adjustedCents;
    if (owed > REPAID_TOLERANCE_CENTS) {
      throw new LoanError(`The books still show ${formatCents(owed)} owed, so it wasn't repaid. Write it off instead if it won't be.`);
    }
    // Completed when the last real principal payment came in.
    const [last] = await tx.execute<{ at: Date | null }>(sql`
      select max(b.occurred_at) as at from loan_payment_link k join bank_transaction b on b.id = k.bank_transaction_id
      where k.loan_id = ${l.id} and k.role in ('principal','early_principal','late_principal') and b.amount_cents >= 10000`).then((r) => r.rows);
    const now = new Date();
    await tx
      .update(loan)
      .set({ status: "completed", completedAt: last?.at ? new Date(last.at) : now, statusLocked: true, statusLockReason: input.reason, nextPaymentDueAt: null, updatedAt: now })
      .where(eq(loan.id, l.id));
    await tx.insert(loanEvent).values({ loanId: l.id, at: now, kind: "marked_repaid", staffId: viewer.staffId, detail: { from: l.status, reason: input.reason, owedCents: owed } });
    await recordAudit(tx, {
      actor: { type: "staff", staffId: viewer.staffId },
      action: "loans.marked_repaid",
      target: { type: "loan", id: l.id },
      reason: input.reason,
      metadata: { from: l.status, owedCents: owed, borrowerStateId: l.borrowerStateId },
      request,
    });
    // Completion clears the small remainder like any finished loan.
    await syncLoans(tx);
  });
}

export const assignOfficerSchema =z.object({ loanId: z.uuid(), officerStaffId: z.uuid().nullable(), reason: reason.optional() });

/**
 * Sets a loan's officer. Management+ may set anyone; an officer may only claim
 * an unassigned loan for themselves.
 */
export async function assignOfficer(viewer: Viewer, raw: z.input<typeof assignOfficerSchema>): Promise<void> {
  const input = assignOfficerSchema.parse(raw);
  const request = await getRequestMeta();

  await db.transaction(async (tx) => {
    const [l] = await tx.select().from(loan).where(and(liveLoan, eq(loan.id, input.loanId))).for("update");
    if (!l) throw new LoanError("Loan not found.");
    if (!canAssignOfficer(viewer, l, input.officerStaffId)) {
      throw new ForbiddenError("Loan officers can only claim unassigned loans for themselves.");
    }
    if (l.officerStaffId === input.officerStaffId) return;
    if (l.officerStaffId && !input.reason) throw new LoanError("Give a reason for changing the officer.");
    if (input.officerStaffId) {
      const finished = l.status === "completed" || l.status === "written_off";
      const statuses = finished ? RECORD_STATUSES : WORKING_STATUSES;
      const [s] = await tx.select({ id: staff.id, role: staff.role }).from(staff).where(and(eq(staff.id, input.officerStaffId), inArray(staff.status, [...statuses])));
      if (!s) throw new LoanError(finished ? "Staff member not found." : "Officers of open loans must be current staff (departed staff can be named on finished loans).");
      if (!canBeOfficer(s)) throw new LoanError(NOT_OFFICER_MESSAGE);
    }
    const now = new Date();
    await tx.update(loan).set({ officerStaffId: input.officerStaffId, updatedAt: now }).where(eq(loan.id, l.id));
    await tx.insert(loanEvent).values({
      loanId: l.id,
      at: now,
      kind: l.officerStaffId ? "officer_changed" : "officer_assigned",
      staffId: viewer.staffId,
      detail: { from: l.officerStaffId, to: input.officerStaffId, reason: input.reason ?? null },
    });
    await recordAudit(tx, {
      actor: { type: "staff", staffId: viewer.staffId },
      action: "loans.officer_assigned",
      target: { type: "loan", id: l.id },
      reason: input.reason,
      metadata: { from: l.officerStaffId, to: input.officerStaffId },
      request,
    });
  });
}

export const addCollateralSchema = z.object({
  loanId: z.uuid(),
  description: z.string().trim().min(2, "Describe the collateral.").max(300),
  estimatedValueCents: z.number().int().positive().max(100_000_000_000).nullable(),
});

export const COLLATERAL_STATUSES = ["held", "repossessed", "sold", "released"] as const;
export const collateralStatusSchema = z.object({ collateralId: z.uuid(), status: z.enum(COLLATERAL_STATUSES), note: z.string().trim().max(300).optional() });

/** Collateral is recorded by hand; anyone who can see the loan's details (Legal+ or its officer) may record it. */
async function mayManageLoan(viewer: Viewer, loanId: string): Promise<typeof loan.$inferSelect> {
  const [l] = await db.select().from(loan).where(and(liveLoan, eq(loan.id, loanId)));
  if (!l) throw new LoanError("Loan not found.");
  if (!canAnnotateLoan(viewer, l)) throw new ForbiddenError();
  return l;
}

export async function addCollateral(viewer: Viewer, raw: z.input<typeof addCollateralSchema>): Promise<void> {
  const input = addCollateralSchema.parse(raw);
  const l = await mayManageLoan(viewer, input.loanId);
  const request = await getRequestMeta();
  await db.transaction(async (tx) => {
    const [c] = await tx
      .insert(loanCollateral)
      .values({ loanId: l.id, description: input.description, estimatedValueCents: input.estimatedValueCents, createdByStaffId: viewer.staffId })
      .returning({ id: loanCollateral.id });
    await tx.insert(loanEvent).values({ loanId: l.id, kind: "collateral_added", staffId: viewer.staffId, detail: { collateralId: c.id, description: input.description } });
    await recordAudit(tx, {
      actor: { type: "staff", staffId: viewer.staffId },
      action: "loans.collateral_added",
      target: { type: "loan", id: l.id },
      metadata: { collateralId: c.id, description: input.description, estimatedValueCents: input.estimatedValueCents },
      request,
    });
  });
}

export async function setCollateralStatus(viewer: Viewer, raw: z.input<typeof collateralStatusSchema>): Promise<void> {
  const input = collateralStatusSchema.parse(raw);
  const [c] = await db.select().from(loanCollateral).where(eq(loanCollateral.id, input.collateralId));
  if (!c) throw new LoanError("Collateral not found.");
  await mayManageLoan(viewer, c.loanId);
  if (c.status === input.status) return;
  const request = await getRequestMeta();
  await db.transaction(async (tx) => {
    await tx.update(loanCollateral).set({ status: input.status, updatedAt: new Date() }).where(eq(loanCollateral.id, c.id));
    await tx.insert(loanEvent).values({
      loanId: c.loanId,
      kind: "collateral_status",
      staffId: viewer.staffId,
      detail: { collateralId: c.id, description: c.description, from: c.status, to: input.status, note: input.note ?? null },
    });
    await recordAudit(tx, {
      actor: { type: "staff", staffId: viewer.staffId },
      action: "loans.collateral_status",
      target: { type: "loan", id: c.loanId },
      metadata: { collateralId: c.id, from: c.status, to: input.status, note: input.note ?? null },
      request,
    });
  });
}

export const noteSchema = z.object({ loanId: z.uuid(), text: z.string().trim().min(1, "Write a note.").max(2000) });

export async function addLoanNote(viewer: Viewer, raw: z.input<typeof noteSchema>): Promise<void> {
  const input = noteSchema.parse(raw);
  const l = await mayManageLoan(viewer, input.loanId);
  const request = await getRequestMeta();
  await db.transaction(async (tx) => {
    const [e] = await tx.insert(loanEvent).values({ loanId: l.id, kind: "note", staffId: viewer.staffId, detail: { text: input.text } }).returning({ id: loanEvent.id });
    await recordAudit(tx, {
      actor: { type: "staff", staffId: viewer.staffId },
      action: "loans.note_added",
      target: { type: "loan", id: l.id },
      metadata: { eventId: e.id, length: input.text.length },
      request,
    });
  });
}
