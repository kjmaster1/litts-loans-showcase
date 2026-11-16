import "server-only";
import { canActOnOffer, canBeOfficer, NOT_OFFICER_MESSAGE } from "@/server/authz/rules";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { renderLoanContract } from "@/domain/origination/contracts";
import { LOAN_KINDS, offerChecks, offerFigures, suggestRate, type BorrowerRecord, type LoanKind, type OfferFlag } from "@/domain/origination/loan-offer";
import { zonedParts } from "@/lib/company-time";
import { can, ForbiddenError } from "@/lib/permissions";
import { recordAudit } from "@/server/audit/audit";
import type { Viewer } from "@/server/authz/viewer";
import { db, type Tx } from "@/server/db";
import { borrowerFlag, liveLoan, loan, loanOffer, staff } from "@/server/db/schema";
import { lendingCheck, type LendingCheck } from "@/server/loans/lending";
import { LoanError } from "@/server/loans/errors";
import { getRequestMeta } from "@/server/request";
import { getSettings } from "@/server/settings";

/**
 * Loan offers (docs/design/ORIGINATION.md): an officer prices a new private loan, checks
 * it against the handbook, and issues the contract. Everyone who makes offers sees
 * everyone's (owner, 2026-10-11: officers help each other); only the offer's officer or
 * management can change it. Warnings never block (owner).
 */

type Offer = typeof loanOffer.$inferSelect;

export { canActOnOffer };
function assertCanTouch(v: Viewer, o: Offer) {
  if (!can(v.role, "loans.originate")) throw new ForbiddenError();
  if (!canActOnOffer(v, o)) throw new ForbiddenError("Only the offer’s officer or management can change it.");
}

/** Midnight UTC of today's UK date (dates arrive as noon UTC on the chosen day). */
function todayUk(): Date {
  const { year, month, day } = zonedParts(new Date());
  return new Date(Date.UTC(year, month - 1, day));
}

const dollars = (max: number) => z.number().int().positive().max(max);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .transform((v) => new Date(`${v}T12:00:00Z`))
  .refine((d) => d >= todayUk(), { message: "Contracts are for new loans: the date can’t be in the past." });

export const offerSchema = z
  .object({
    kind: z.enum(LOAN_KINDS),
    borrowerStateId: z.number().int().positive().max(9_999_999),
    borrowerName: z.string().trim().min(2, "Give the borrower’s name.").max(80),
    amountDollars: dollars(50_000_000),
    ratePct: z.number().min(0).max(100),
    stateRatePct: z.number().min(0).max(100),
    weeks: z.number().int().min(1).max(104),
    startsOn: date,
    collateral: z.string().trim().max(200).nullish(),
    collateralValueDollars: dollars(100_000_000).nullish(),
    purpose: z.string().trim().max(200).nullish(),
    weeklyIncomeDollars: dollars(50_000_000).nullish(),
    defaultFeePerDayDollars: z.number().int().min(0).max(1_000_000),
    suggestedRatePct: z.number().min(0).max(100).nullish(),
    notes: z.string().trim().max(2000).default(""),
    /** Management+ may make an offer on another officer's behalf. */
    officerStaffId: z.uuid().nullish(),
  })
  .refine((v) => v.kind === "general" || (v.collateral && v.collateral.length >= 2), {
    message: "Give the vehicle’s make & model or the property’s address.",
    path: ["collateral"],
  });

function toRow(input: z.output<typeof offerSchema>) {
  return {
    kind: input.kind,
    borrowerStateId: input.borrowerStateId,
    borrowerName: input.borrowerName,
    amountCents: input.amountDollars * 100,
    rateBp: Math.round(input.ratePct * 100),
    stateRateBp: Math.round(input.stateRatePct * 100),
    weeks: input.weeks,
    startsOn: input.startsOn,
    collateral: input.collateral || null,
    collateralValueCents: input.collateralValueDollars ? input.collateralValueDollars * 100 : null,
    purpose: input.kind === "general" ? input.purpose || null : null,
    weeklyIncomeCents: input.weeklyIncomeDollars ? input.weeklyIncomeDollars * 100 : null,
    defaultFeePerDayCents: input.defaultFeePerDayDollars * 100,
    suggestedRateBp: input.suggestedRatePct != null ? Math.round(input.suggestedRatePct * 100) : null,
    notes: input.notes,
  };
}

async function officerFor(viewer: Viewer, requested: string | null | undefined): Promise<string> {
  if (!requested || requested === viewer.staffId) {
    if (!canBeOfficer(viewer)) throw new LoanError(NOT_OFFICER_MESSAGE);
    return viewer.staffId;
  }
  if (!can(viewer.role, "loans.reassign_officer")) throw new ForbiddenError("Only management can make an offer for another officer.");
  const [s] = await db.select({ id: staff.id, role: staff.role }).from(staff).where(eq(staff.id, requested));
  if (!s) throw new LoanError("That officer doesn’t exist.");
  if (!canBeOfficer(s)) throw new LoanError(NOT_OFFICER_MESSAGE);
  return s.id;
}

export async function createOffer(viewer: Viewer, raw: z.input<typeof offerSchema>): Promise<string> {
  if (!can(viewer.role, "loans.originate")) throw new ForbiddenError();
  const input = offerSchema.parse(raw);
  const g = (await getSettings()).loans;
  const officerStaffId = await officerFor(viewer, input.officerStaffId);
  const request = await getRequestMeta();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(loanOffer)
      .values({
        ...toRow(input),
        officerStaffId,
        purchaseDays: g.purchaseDays,
        detailsHours: g.detailsHours,
        extraHours: g.extraHours,
        defaultAfterDays: g.defaultAfterDays,
        createdByStaffId: viewer.staffId,
      })
      .returning({ id: loanOffer.id, number: loanOffer.number });
    await recordAudit(tx, {
      actor: { type: "staff", staffId: viewer.staffId },
      action: "loans.offer.created",
      target: { type: "loan_offer", id: row.id },
      metadata: { number: row.number, kind: input.kind, borrowerStateId: input.borrowerStateId, amountDollars: input.amountDollars, ratePct: input.ratePct, weeks: input.weeks },
      request,
    });
    return row.id;
  });
}

async function loadForChange(tx: Tx, viewer: Viewer, id: string): Promise<Offer> {
  const [o] = await tx.select().from(loanOffer).where(eq(loanOffer.id, id)).for("update");
  if (!o) throw new LoanError("Offer not found.");
  assertCanTouch(viewer, o);
  return o;
}

export async function updateOffer(viewer: Viewer, id: string, raw: z.input<typeof offerSchema>): Promise<void> {
  const input = offerSchema.parse(raw);
  const request = await getRequestMeta();
  await db.transaction(async (tx) => {
    const o = await loadForChange(tx, viewer, id);
    if (o.status !== "draft") throw new LoanError("Only a draft can be changed. Cancel this offer and make a new one.");
    const officerStaffId = await officerFor(viewer, input.officerStaffId ?? o.officerStaffId);
    await tx.update(loanOffer).set({ ...toRow(input), officerStaffId, updatedAt: new Date() }).where(eq(loanOffer.id, id));
    await recordAudit(tx, {
      actor: { type: "staff", staffId: viewer.staffId },
      action: "loans.offer.updated",
      target: { type: "loan_offer", id },
      metadata: { number: o.number, amountDollars: input.amountDollars, ratePct: input.ratePct, weeks: input.weeks },
      request,
    });
  });
}

function contractFor(o: Offer, officer: { characterName: string; stateId: number }): string {
  const f = offerFigures(termsOf(o));
  return renderLoanContract({
    kind: o.kind,
    date: o.startsOn,
    borrowerName: o.borrowerName,
    borrowerStateId: o.borrowerStateId,
    amountCents: o.amountCents,
    ratePct: o.rateBp / 100,
    totalCents: f.totalCents,
    weeks: o.weeks,
    schedule: f.schedule,
    collateral: o.collateral,
    purpose: o.purpose,
    defaultFeePerDayCents: o.defaultFeePerDayCents,
    purchaseDays: o.purchaseDays,
    detailsHours: o.detailsHours,
    extraHours: o.extraHours,
    defaultAfterDays: o.defaultAfterDays,
    representativeName: officer.characterName,
    representativeStateId: officer.stateId,
  });
}

/** Freezes the contract text. The date must still be today or later. */
export async function issueOffer(viewer: Viewer, id: string): Promise<void> {
  const request = await getRequestMeta();
  await db.transaction(async (tx) => {
    const o = await loadForChange(tx, viewer, id);
    if (o.status !== "draft") throw new LoanError("This offer has already been issued or cancelled.");
    if (o.startsOn < todayUk()) throw new LoanError("The contract date has passed. Change it to today or later first.");
    const [officer] = await tx.select({ characterName: staff.characterName, stateId: staff.stateId }).from(staff).where(eq(staff.id, o.officerStaffId));
    const contractText = contractFor(o, officer);
    await tx.update(loanOffer).set({ status: "issued", contractText, issuedAt: new Date(), issuedByStaffId: viewer.staffId, updatedAt: new Date() }).where(eq(loanOffer.id, id));
    await recordAudit(tx, {
      actor: { type: "staff", staffId: viewer.staffId },
      action: "loans.offer.issued",
      target: { type: "loan_offer", id },
      metadata: { number: o.number, borrowerStateId: o.borrowerStateId, amountCents: o.amountCents, rateBp: o.rateBp, weeks: o.weeks, flags: checksFor(o).map((f) => f.text) },
      request,
    });
  });
}

export const cancelOfferSchema = z.object({ id: z.uuid(), reason: z.string().trim().min(3, "Give a short reason.").max(500) });

export async function cancelOffer(viewer: Viewer, raw: z.input<typeof cancelOfferSchema>): Promise<void> {
  const { id, reason } = cancelOfferSchema.parse(raw);
  const request = await getRequestMeta();
  await db.transaction(async (tx) => {
    const o = await loadForChange(tx, viewer, id);
    if (o.status === "funded" || o.status === "cancelled") throw new LoanError(`This offer is already ${o.status === "funded" ? "paid out" : "cancelled"}.`);
    await tx.update(loanOffer).set({ status: "cancelled", cancelledAt: new Date(), cancelReason: reason, updatedAt: new Date() }).where(eq(loanOffer.id, id));
    await recordAudit(tx, { actor: { type: "staff", staffId: viewer.staffId }, action: "loans.offer.cancelled", target: { type: "loan_offer", id }, reason, metadata: { number: o.number }, request });
  });
}

export function termsOf(o: Pick<Offer, "amountCents" | "rateBp" | "stateRateBp" | "weeks" | "startsOn" | "collateralValueCents" | "weeklyIncomeCents">) {
  return {
    amountCents: o.amountCents,
    ratePct: o.rateBp / 100,
    stateRatePct: o.stateRateBp / 100,
    weeks: o.weeks,
    startsOn: o.startsOn,
    collateralValueCents: o.collateralValueCents,
    weeklyIncomeCents: o.weeklyIncomeCents,
  };
}

export function checksFor(o: Offer, g?: Parameters<typeof offerChecks>[3]): OfferFlag[] {
  const t = termsOf(o);
  return offerChecks(o.kind, { ...t, defaultFeePerDayCents: o.defaultFeePerDayCents }, offerFigures(t), g);
}

export type OfferRow = Offer & { officerName: string | null; loanStatus: string | null };

export async function listOffers(viewer: Viewer, filter: { status?: Offer["status"] | "open"; mine?: boolean } = {}): Promise<OfferRow[]> {
  if (!can(viewer.role, "loans.originate")) throw new ForbiddenError();
  const status = filter.status === "open" ? inArray(loanOffer.status, ["draft", "issued"]) : filter.status ? eq(loanOffer.status, filter.status) : undefined;
  const mine = filter.mine ? eq(loanOffer.officerStaffId, viewer.staffId) : undefined;
  const rows = await db
    .select({ o: loanOffer, officerName: staff.characterName, loanStatus: loan.status })
    .from(loanOffer)
    .leftJoin(staff, eq(staff.id, loanOffer.officerStaffId))
    .leftJoin(loan, eq(loan.id, loanOffer.loanId))
    .where(and(mine, status))
    .orderBy(desc(loanOffer.createdAt))
    .limit(300);
  return rows.map((r) => ({ ...r.o, officerName: r.officerName, loanStatus: r.loanStatus }));
}

export async function getOffer(viewer: Viewer, id: string): Promise<OfferRow | null> {
  if (!can(viewer.role, "loans.originate")) throw new ForbiddenError();
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const [r] = await db
    .select({ o: loanOffer, officerName: staff.characterName, loanStatus: loan.status })
    .from(loanOffer)
    .leftJoin(staff, eq(staff.id, loanOffer.officerStaffId))
    .leftJoin(loan, eq(loan.id, loanOffer.loanId))
    .where(eq(loanOffer.id, id));
  return r ? { ...r.o, officerName: r.officerName, loanStatus: r.loanStatus } : null;
}

/** What the rate guide and the checks need to know about a borrower. */
export async function borrowerForOffer(viewer: Viewer, stateId: number): Promise<{ name: string | null; record: BorrowerRecord; check: LendingCheck }> {
  if (!can(viewer.role, "loans.originate")) throw new ForbiddenError();
  const [rows, check, flag] = await Promise.all([
    db.select({ name: loan.borrowerName, status: loan.status, firstDefaultAt: loan.firstDefaultAt }).from(loan).where(and(liveLoan, eq(loan.borrowerStateId, stateId))),
    lendingCheck(viewer, stateId, {}),
    db.select({ id: borrowerFlag.id }).from(borrowerFlag).where(and(eq(borrowerFlag.borrowerStateId, stateId), isNull(borrowerFlag.clearedAt))),
  ]);
  const [offerName] = rows.length ? [] : await db.select({ name: loanOffer.borrowerName }).from(loanOffer).where(eq(loanOffer.borrowerStateId, stateId)).limit(1);
  return {
    name: rows.find((r) => r.name)?.name ?? offerName?.name ?? null,
    record: {
      repaid: rows.filter((r) => r.status === "completed" && !r.firstDefaultAt).length,
      wentBad: rows.filter((r) => r.status === "defaulted" || r.status === "written_off" || r.firstDefaultAt !== null).length,
      open: rows.filter((r) => r.status === "active" || r.status === "overdue" || r.status === "defaulted").length,
      doNotLend: flag.length > 0,
    },
    check,
  };
}

export { suggestRate };
export type { LoanKind };

/** The offer a loan was paid out under, if the viewer may see it. */
export async function offerForLoan(viewer: Viewer, loanId: string): Promise<{ id: string; number: number } | null> {
  if (!can(viewer.role, "loans.originate")) return null;
  const [o] = await db.select({ id: loanOffer.id, number: loanOffer.number }).from(loanOffer).where(eq(loanOffer.loanId, loanId));
  return o ?? null;
}

/*
 * Correcting the automatic match (owner review, 2026-10-11): the sync pairs an issued offer
 * with the loan the game paid out by borrower, amount and date. When it picks the wrong one,
 * the offer's officer or management unlinks it ("not this loan" — remembered, so the sync
 * never pairs them again) and can link the right loan by hand. Both are audited with a reason.
 */
export const unlinkOfferSchema = z.object({ id: z.uuid(), reason: z.string().trim().min(5, "Give a reason (at least 5 characters).").max(500) });
export const linkOfferSchema = z.object({ id: z.uuid(), loanId: z.uuid(), reason: z.string().trim().min(5, "Give a reason (at least 5 characters).").max(500) });

export async function unlinkOffer(viewer: Viewer, raw: z.input<typeof unlinkOfferSchema>): Promise<void> {
  const { id, reason } = unlinkOfferSchema.parse(raw);
  const request = await getRequestMeta();
  await db.transaction(async (tx) => {
    const [o] = await tx.select().from(loanOffer).where(eq(loanOffer.id, id)).for("update");
    if (!o) throw new LoanError("Offer not found.");
    assertCanTouch(viewer, o);
    if (o.status !== "funded" || !o.loanId) throw new LoanError("This offer isn't linked to a loan.");
    await tx
      .update(loanOffer)
      .set({ status: "issued", loanId: null, fundedAt: null, excludedLoanIds: [...new Set([...o.excludedLoanIds, o.loanId])], updatedAt: new Date() })
      .where(eq(loanOffer.id, id));
    await recordAudit(tx, {
      actor: { type: "staff", staffId: viewer.staffId },
      action: "loans.offer.unlinked",
      target: { type: "loan_offer", id },
      reason,
      metadata: { number: o.number, loanId: o.loanId },
      request,
    });
  });
}

export type LoanCandidate = { id: string; principalCents: number; openedAt: Date | null; status: string; linkedOfferNumber: number | null };

/** The borrower's loans, newest first, with any offer each is already linked to. */
export async function loanCandidates(viewer: Viewer, offerId: string): Promise<LoanCandidate[]> {
  if (!can(viewer.role, "loans.originate")) throw new ForbiddenError();
  const [o] = await db.select().from(loanOffer).where(eq(loanOffer.id, offerId));
  if (!o) return [];
  const rows = await db
    .select({ id: loan.id, principalCents: loan.principalCents, openedAt: loan.openedAt, status: loan.status, linkedOfferNumber: loanOffer.number })
    .from(loan)
    .leftJoin(loanOffer, eq(loanOffer.loanId, loan.id))
    .where(and(liveLoan, eq(loan.borrowerStateId, o.borrowerStateId)))
    .orderBy(desc(loan.openedAt));
  return rows;
}

export async function linkOffer(viewer: Viewer, raw: z.input<typeof linkOfferSchema>): Promise<void> {
  const { id, loanId, reason } = linkOfferSchema.parse(raw);
  const request = await getRequestMeta();
  await db.transaction(async (tx) => {
    const [o] = await tx.select().from(loanOffer).where(eq(loanOffer.id, id)).for("update");
    if (!o) throw new LoanError("Offer not found.");
    assertCanTouch(viewer, o);
    if (o.status !== "issued") throw new LoanError("Only an issued offer that isn't linked yet can be linked to a loan.");
    const [l] = await tx.select().from(loan).where(and(liveLoan, eq(loan.id, loanId)));
    if (!l || l.borrowerStateId !== o.borrowerStateId) throw new LoanError("That loan isn't this borrower's.");
    const [other] = await tx.select({ number: loanOffer.number }).from(loanOffer).where(eq(loanOffer.loanId, loanId));
    if (other) throw new LoanError(`That loan is already linked to offer #${other.number}. Unlink it there first.`);
    await tx
      .update(loanOffer)
      .set({ status: "funded", loanId, fundedAt: l.openedAt ?? new Date(), excludedLoanIds: o.excludedLoanIds.filter((x) => x !== loanId), updatedAt: new Date() })
      .where(eq(loanOffer.id, id));
    await recordAudit(tx, {
      actor: { type: "staff", staffId: viewer.staffId },
      action: "loans.offer.linked",
      target: { type: "loan_offer", id },
      reason,
      metadata: { number: o.number, loanId },
      request,
    });
  });
}
