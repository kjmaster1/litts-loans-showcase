import "server-only";
import { SERVER_AGGREGATE } from "@/server/authz/rules";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { lendingFlags, trackRecord, type FinishedLoan, type LendingFlag, type TrackRecord } from "@/domain/loans/lending";
import { can, ForbiddenError } from "@/lib/permissions";
import { recordAudit } from "@/server/audit/audit";
import type { Viewer } from "@/server/authz/viewer";
import { db } from "@/server/db";
import { borrowerFlag, liveLoan, loan, staff } from "@/server/db/schema";
import { listMortgages } from "@/server/mortgages/queries";
import { getRequestMeta } from "@/server/request";
import { LoanError } from "./errors";
import { listLoans } from "./queries";

/** "Can we lend?" (research/11): history and red flags for a State ID. Information only. */

/** Every finished loan, with whether it went bad and whether it overlapped another of the borrower's loans. */
export async function companyTrackRecord(): Promise<TrackRecord> {
  const rows = await db
    .select({ id: loan.id, stateId: loan.borrowerStateId, principal: loan.principalCents, rate: loan.brokerRateBp, status: loan.status, openedAt: loan.openedAt, completedAt: loan.completedAt })
    .from(loan)
    .where(liveLoan);
  const finished: FinishedLoan[] = rows
    .filter((r) => r.status !== "active" && r.status !== "overdue")
    .map((r) => ({
      principalCents: r.principal,
      brokerRateBp: r.rate,
      bad: r.status === "defaulted" || r.status === "written_off",
      overlapped: rows.some(
        (o) => o.id !== r.id && o.stateId === r.stateId && o.openedAt && r.openedAt && o.openedAt < r.openedAt && (!o.completedAt || o.completedAt > r.openedAt),
      ),
    }));
  return trackRecord(finished);
}

export type LendingCheck = {
  stateId: number;
  flags: LendingFlag[];
  doNotLend: { reason: string; by: string; at: Date } | null;
  record: TrackRecord;
};

export async function lendingCheck(viewer: Viewer, stateId: number, request: { amountCents?: number | null; rateBp?: number | null }): Promise<LendingCheck> {
  if (!can(viewer.role, "borrower.lookup")) throw new ForbiddenError();
  const [flagRows, history, loans, mortgages, staffRow, record] = await Promise.all([
    db
      .select({ reason: borrowerFlag.reason, at: borrowerFlag.setAt, by: staff.characterName })
      .from(borrowerFlag)
      .innerJoin(staff, eq(staff.id, borrowerFlag.setByStaffId))
      .where(and(eq(borrowerFlag.borrowerStateId, stateId), isNull(borrowerFlag.clearedAt))),
    db.select({ id: loan.id, firstDefaultAt: loan.firstDefaultAt }).from(loan).where(and(liveLoan, eq(loan.borrowerStateId, stateId))),
    // Exposure is an aggregate the lookup may show anyone; loan details stay per-viewer.
    listLoans(SERVER_AGGREGATE, { status: "all", q: String(stateId) }),
    listMortgages(SERVER_AGGREGATE, { status: "all", q: String(stateId) }),
    db.select({ id: staff.id }).from(staff).where(eq(staff.stateId, stateId)),
    companyTrackRecord(),
  ]);
  const everDefaulted = new Set(history.filter((h) => h.firstDefaultAt).map((h) => h.id));
  const doNotLend = flagRows[0] ?? null;
  const flags = lendingFlags(
    {
      doNotLend,
      loans: loans.filter((l) => l.borrowerStateId === stateId).map((l) => ({ status: l.status, everDefaulted: everDefaulted.has(l.id) || l.status === "defaulted" || l.status === "written_off", outstandingCents: l.outstandingCents })),
      mortgagesBehind: mortgages.filter((m) => m.buyerStateId === stateId && m.status === "active" && m.state?.kind === "behind").length,
      isStaff: staffRow.length > 0,
    },
    request,
    record,
  );
  return { stateId, flags, doNotLend, record };
}

export const doNotLendSchema = z.object({
  stateId: z.number().int().positive().max(9_999_999),
  reason: z.string().trim().min(5, "Give a reason (at least 5 characters).").max(500),
});

/** Management+. */
export async function setDoNotLend(viewer: Viewer, raw: z.input<typeof doNotLendSchema>): Promise<void> {
  if (!can(viewer.role, "loans.edit_metadata")) throw new ForbiddenError();
  const input = doNotLendSchema.parse(raw);
  const request = await getRequestMeta();
  await db.transaction(async (tx) => {
    const [open] = await tx.select({ id: borrowerFlag.id }).from(borrowerFlag).where(and(eq(borrowerFlag.borrowerStateId, input.stateId), isNull(borrowerFlag.clearedAt)));
    if (open) throw new LoanError("This borrower is already marked do not lend.");
    const [row] = await tx.insert(borrowerFlag).values({ borrowerStateId: input.stateId, reason: input.reason, setByStaffId: viewer.staffId }).returning({ id: borrowerFlag.id });
    await recordAudit(tx, {
      actor: { type: "staff", staffId: viewer.staffId },
      action: "borrowers.flag.set",
      target: { type: "borrower", id: String(input.stateId) },
      reason: input.reason,
      metadata: { flagId: row.id },
      request,
    });
  });
}

/** Management+. */
export async function clearDoNotLend(viewer: Viewer, raw: z.input<typeof doNotLendSchema>): Promise<void> {
  if (!can(viewer.role, "loans.edit_metadata")) throw new ForbiddenError();
  const input = doNotLendSchema.parse(raw);
  const request = await getRequestMeta();
  await db.transaction(async (tx) => {
    const cleared = await tx
      .update(borrowerFlag)
      .set({ clearedAt: new Date(), clearedByStaffId: viewer.staffId, clearReason: input.reason })
      .where(and(eq(borrowerFlag.borrowerStateId, input.stateId), isNull(borrowerFlag.clearedAt)))
      .returning({ id: borrowerFlag.id });
    if (cleared.length === 0) throw new LoanError("This borrower isn't marked do not lend.");
    await recordAudit(tx, {
      actor: { type: "staff", staffId: viewer.staffId },
      action: "borrowers.flag.cleared",
      target: { type: "borrower", id: String(input.stateId) },
      reason: input.reason,
      metadata: { flagId: cleared[0].id },
      request,
    });
  });
}
