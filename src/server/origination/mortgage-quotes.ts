import "server-only";
import { canActOnQuote, canApproveQuote, canBeOfficer, NOT_OFFICER_MESSAGE } from "@/server/authz/rules";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { approvedTermsChanged, needsExecutiveApproval } from "@/domain/mortgages/approval";
import { federalMaximumBreaches, quoteChecks, quoteMortgage, type MortgageQuoteInput } from "@/domain/origination/mortgage-quote";
import { isLiveQuote, LIVE_QUOTE_STATUSES, type QuoteStatus } from "@/domain/origination/quote-status";
import { can, ForbiddenError } from "@/lib/permissions";
import { recordAudit } from "@/server/audit/audit";
import type { Viewer } from "@/server/authz/viewer";
import { db, type Tx } from "@/server/db";
import { mortgage, mortgageQuote, staff } from "@/server/db/schema";
import { LoanError } from "@/server/loans/errors";
import { getRequestMeta } from "@/server/request";
import { getSettings } from "@/server/settings";

/**
 * Mortgage quotes (docs/design/ORIGINATION.md): the officer works out the terms with the
 * buyer within the handbook, then types them into the tablet. A quote is matched to the
 * mortgage once the sale agreement is pasted (same buyer, same loan amount or address).
 * Everyone who quotes sees everyone's quotes (owner, 2026-10-11) — so the team knows what's
 * about to draw on the State allowance; only the quote's officer or management changes one.
 * Over the executive-approval line (research/18) a quote waits for an executive's approval before
 * it goes on the tablet: an executive's own save approves it; anyone else's change to the approved
 * terms clears the approval.
 */

type Quote = typeof mortgageQuote.$inferSelect;

export { canActOnQuote };

export const quoteSchema = z.object({
  buyerStateId: z.number().int().positive().max(9_999_999),
  buyerName: z.string().trim().min(2, "Give the buyer’s name.").max(80),
  address: z.string().trim().min(3, "Give the property’s address.").max(120),
  priceDollars: z.number().int().positive().max(100_000_000),
  agencyCommissionDollars: z.number().int().min(0).max(100_000_000),
  // 100% down is a cash sale: there'd be no loan.
  downPaymentPct: z.number().min(0).max(99),
  termMonths: z.number().int().min(1).max(24),
  fedRatePct: z.number().min(0).max(100),
  brokerRatePct: z.number().min(0).max(100),
  bankerFeePct: z.number().min(0).max(100),
  primaryResidence: z.boolean(),
  companyFunded: z.boolean().default(false),
  notes: z.string().trim().max(2000).default(""),
  /** Omitted keeps what's stored, null clears it (not on a confirmed quote), a date sets it. */
  expectedSigningAt: z.coerce.date().nullable().optional(),
});

const CLOCK_SKEW_MS = 5 * 60_000;
const DAY_MS = 86_400_000;

function assertNotPast(at: Date, now: Date) {
  if (at.getTime() < now.getTime() - CLOCK_SKEW_MS) throw new LoanError("The signing time can’t be in the past.");
}

export function inputOf(
  q: Pick<Quote, "priceCents" | "agencyCommissionCents" | "downPaymentBp" | "termMonths" | "fedRateBp" | "brokerRateBp" | "bankerFeeBp" | "primaryResidence" | "companyFunded">,
): MortgageQuoteInput {
  return {
    priceCents: q.priceCents,
    agencyCommissionCents: q.agencyCommissionCents,
    downPaymentPct: q.downPaymentBp / 100,
    termMonths: q.termMonths,
    fedRatePct: q.fedRateBp / 100,
    brokerRatePct: q.brokerRateBp / 100,
    bankerFeePct: q.bankerFeeBp / 100,
    primaryResidence: q.primaryResidence,
    companyFunded: q.companyFunded,
  };
}

function toRow(i: z.output<typeof quoteSchema>) {
  return {
    buyerStateId: i.buyerStateId,
    buyerName: i.buyerName,
    address: i.address,
    priceCents: i.priceDollars * 100,
    agencyCommissionCents: i.agencyCommissionDollars * 100,
    downPaymentBp: Math.round(i.downPaymentPct * 100),
    termMonths: i.termMonths,
    fedRateBp: Math.round(i.fedRatePct * 100),
    brokerRateBp: Math.round(i.brokerRatePct * 100),
    bankerFeeBp: Math.round(i.bankerFeePct * 100),
    primaryResidence: i.primaryResidence,
    companyFunded: i.companyFunded,
    notes: i.notes,
  };
}

export async function saveQuote(viewer: Viewer, raw: z.input<typeof quoteSchema>, id?: string): Promise<string> {
  return (await saveQuoteDetailed(viewer, raw, id)).id;
}

/** `backToDraft`: the save changed approved figures, so a confirmed quote is a draft again. */
export async function saveQuoteDetailed(viewer: Viewer, raw: z.input<typeof quoteSchema>, id?: string): Promise<{ id: string; backToDraft: boolean }> {
  if (!can(viewer.role, "loans.originate")) throw new ForbiddenError();
  const input = quoteSchema.parse(raw);
  // The quote's officer is whoever makes it (management edits keep it): never the Legal Team.
  if (!id && !canBeOfficer(viewer)) throw new LoanError(NOT_OFFICER_MESSAGE);
  if (input.agencyCommissionDollars >= input.priceDollars) throw new LoanError("The agency’s commission can’t be the whole price.");
  // The federal maximums are strict (owner, 2026-10-15): nobody saves a quote over them, management included.
  const row = toRow(input);
  const terms = inputOf(row);
  const g = (await getSettings()).mortgages;
  const over = federalMaximumBreaches(quoteChecks(terms, quoteMortgage(terms), g));
  if (over.length) throw new LoanError(`${over.map((f) => f.text).join(". ")}.`);
  const needsApproval = needsExecutiveApproval(quoteMortgage(terms).baseCents, g);
  const request = await getRequestMeta();
  return db.transaction(async (tx) => {
    const now = new Date();
    if (id) {
      const [q] = await tx.select().from(mortgageQuote).where(eq(mortgageQuote.id, id)).for("update");
      if (!q) throw new LoanError("Quote not found.");
      if (!canActOnQuote(viewer, q)) throw new ForbiddenError("Only the quote’s officer or management can change it.");
      if (!isLiveQuote(q.status)) throw new LoanError("This quote is closed.");
      let signing: { expectedSigningAt: Date | null } | undefined;
      if (input.expectedSigningAt === null) {
        if (q.status === "confirmed") throw new LoanError("A confirmed quote needs its signing time.");
        signing = { expectedSigningAt: null };
      } else if (input.expectedSigningAt) {
        if (input.expectedSigningAt.getTime() !== q.expectedSigningAt?.getTime()) assertNotPast(input.expectedSigningAt, now);
        signing = { expectedSigningAt: input.expectedSigningAt };
      }
      // Changed figures withdraw a confirmation, unless the quote is already signed in game.
      const unconfirm = q.status === "confirmed" && q.signedAt === null && approvedTermsChanged(q, row);
      const confirmation = unconfirm ? { status: "draft" as const, confirmedAt: null, confirmedByStaffId: null } : {};
      // An approval covers the terms it approved; an executive saving the quote approves what they saved.
      const keep = q.approvedAt !== null && !approvedTermsChanged(q, row);
      const approval = !needsApproval
        ? { approvedAt: null, approvedByStaffId: null }
        : keep
          ? { approvedAt: q.approvedAt, approvedByStaffId: q.approvedByStaffId }
          : canApproveQuote(viewer)
            ? { approvedAt: now, approvedByStaffId: viewer.staffId }
            : { approvedAt: null, approvedByStaffId: null };
      await tx.update(mortgageQuote).set({ ...row, ...approval, ...signing, ...confirmation, updatedAt: now }).where(eq(mortgageQuote.id, id));
      const approvalChange = approval.approvedAt === q.approvedAt ? undefined : approval.approvedAt ? "approved" : q.approvedAt ? "cleared" : undefined;
      await recordAudit(tx, {
        actor: { type: "staff", staffId: viewer.staffId },
        action: "mortgages.quote.updated",
        target: { type: "mortgage_quote", id },
        metadata: {
          number: q.number,
          address: input.address,
          ...(approvalChange ? { approval: approvalChange } : {}),
          ...(unconfirm ? { confirmation: "cleared" } : {}),
          ...(signing && signing.expectedSigningAt?.getTime() !== q.expectedSigningAt?.getTime()
            ? { expectedSigningAt: { from: q.expectedSigningAt?.toISOString() ?? null, to: signing.expectedSigningAt?.toISOString() ?? null } }
            : {}),
        },
        request,
      });
      return { id, backToDraft: unconfirm };
    }
    if (input.expectedSigningAt) assertNotPast(input.expectedSigningAt, now);
    const approval = needsApproval && canApproveQuote(viewer) ? { approvedAt: now, approvedByStaffId: viewer.staffId } : {};
    const [created] = await tx
      .insert(mortgageQuote)
      .values({ ...row, ...approval, expectedSigningAt: input.expectedSigningAt ?? null, officerStaffId: viewer.staffId, createdByStaffId: viewer.staffId })
      .returning({ id: mortgageQuote.id, number: mortgageQuote.number });
    await recordAudit(tx, {
      actor: { type: "staff", staffId: viewer.staffId },
      action: "mortgages.quote.created",
      target: { type: "mortgage_quote", id: created.id },
      metadata: {
        number: created.number,
        address: input.address,
        buyerStateId: input.buyerStateId,
        priceDollars: input.priceDollars,
        ...(needsApproval ? { approval: "approvedAt" in approval ? "approved" : "needed" } : {}),
      },
      request,
    });
    return { id: created.id, backToDraft: false };
  });
}

export const cancelQuoteSchema = z.object({ id: z.uuid(), reason: z.string().trim().min(3, "Give a short reason.").max(500) });

export async function cancelQuote(viewer: Viewer, raw: z.input<typeof cancelQuoteSchema>): Promise<void> {
  const { id, reason } = cancelQuoteSchema.parse(raw);
  const request = await getRequestMeta();
  await db.transaction(async (tx) => {
    const [q] = await tx.select().from(mortgageQuote).where(eq(mortgageQuote.id, id)).for("update");
    if (!q) throw new LoanError("Quote not found.");
    if (!canActOnQuote(viewer, q)) throw new ForbiddenError("Only the quote’s officer or management can cancel it.");
    if (!isLiveQuote(q.status)) throw new LoanError("This quote is already closed.");
    await tx.update(mortgageQuote).set({ status: "cancelled", cancelledAt: new Date(), cancelReason: reason, updatedAt: new Date() }).where(eq(mortgageQuote.id, id));
    await recordAudit(tx, { actor: { type: "staff", staffId: viewer.staffId }, action: "mortgages.quote.cancelled", target: { type: "mortgage_quote", id }, reason, metadata: { number: q.number }, request });
  });
}

export const confirmQuoteSchema = z.object({ id: z.uuid(), expectedSigningAt: z.coerce.date() });
export const unconfirmQuoteSchema = z.object({ id: z.uuid() });
export const markSignedSchema = z.object({ id: z.uuid(), signedAt: z.coerce.date() });

/** Draft to confirmed: the buyer has agreed and the sale has a signing time (research/19 §1). */
export async function confirmQuote(viewer: Viewer, raw: z.input<typeof confirmQuoteSchema>): Promise<void> {
  const { id, expectedSigningAt } = confirmQuoteSchema.parse(raw);
  const request = await getRequestMeta();
  await db.transaction(async (tx) => {
    const now = new Date();
    const [q] = await tx.select().from(mortgageQuote).where(eq(mortgageQuote.id, id)).for("update");
    if (!q) throw new LoanError("Quote not found.");
    if (!canActOnQuote(viewer, q)) throw new ForbiddenError("Only the quote’s officer or management can confirm it.");
    if (q.status !== "draft") throw new LoanError("Only a draft can be confirmed.");
    assertNotPast(expectedSigningAt, now);
    await tx.update(mortgageQuote).set({ status: "confirmed", expectedSigningAt, confirmedAt: now, confirmedByStaffId: viewer.staffId, updatedAt: now }).where(eq(mortgageQuote.id, id));
    await recordAudit(tx, {
      actor: { type: "staff", staffId: viewer.staffId },
      action: "mortgages.quote.confirmed",
      target: { type: "mortgage_quote", id },
      metadata: { number: q.number, expectedSigningAt: expectedSigningAt.toISOString() },
      request,
    });
  });
}

/** Confirmed back to draft: clears the confirmation and any signed mark, keeps the signing time. */
export async function unconfirmQuote(viewer: Viewer, raw: z.input<typeof unconfirmQuoteSchema>): Promise<void> {
  const { id } = unconfirmQuoteSchema.parse(raw);
  const request = await getRequestMeta();
  await db.transaction(async (tx) => {
    const [q] = await tx.select().from(mortgageQuote).where(eq(mortgageQuote.id, id)).for("update");
    if (!q) throw new LoanError("Quote not found.");
    if (!canActOnQuote(viewer, q)) throw new ForbiddenError("Only the quote’s officer or management can change it.");
    if (q.status !== "confirmed") throw new LoanError("Only a confirmed quote can go back to draft.");
    await tx
      .update(mortgageQuote)
      .set({ status: "draft", confirmedAt: null, confirmedByStaffId: null, signedAt: null, signedByStaffId: null, updatedAt: new Date() })
      .where(eq(mortgageQuote.id, id));
    await recordAudit(tx, { actor: { type: "staff", staffId: viewer.staffId }, action: "mortgages.quote.unconfirmed", target: { type: "mortgage_quote", id }, metadata: { number: q.number }, request });
  });
}

/** The sale was signed in game but the tablet isn't pasted yet. */
export async function markQuoteSigned(viewer: Viewer, raw: z.input<typeof markSignedSchema>): Promise<void> {
  const { id, signedAt } = markSignedSchema.parse(raw);
  const request = await getRequestMeta();
  await db.transaction(async (tx) => {
    const now = new Date();
    const [q] = await tx.select().from(mortgageQuote).where(eq(mortgageQuote.id, id)).for("update");
    if (!q) throw new LoanError("Quote not found.");
    if (!canActOnQuote(viewer, q)) throw new ForbiddenError("Only the quote’s officer or management can change it.");
    if (q.status !== "confirmed") throw new LoanError("Only a confirmed quote can be marked signed.");
    if (q.signedAt !== null) throw new LoanError("It’s already marked signed. Move it back to draft to change that.");
    if (signedAt.getTime() > now.getTime() + CLOCK_SKEW_MS) throw new LoanError("That time is in the future.");
    if (signedAt.getTime() < q.createdAt.getTime() - DAY_MS) throw new LoanError("That’s before the quote was made.");
    await tx.update(mortgageQuote).set({ signedAt, signedByStaffId: viewer.staffId, updatedAt: now }).where(eq(mortgageQuote.id, id));
    await recordAudit(tx, {
      actor: { type: "staff", staffId: viewer.staffId },
      action: "mortgages.quote.signed",
      target: { type: "mortgage_quote", id },
      metadata: { number: q.number, signedAt: signedAt.toISOString() },
      request,
    });
  });
}

export type QuoteRow = Quote & { officerName: string | null; mortgageAddress: string | null; approvedByName: string | null; confirmedByName: string | null; signedByName: string | null };

const approver = alias(staff, "approver");
const confirmer = alias(staff, "confirmer");
const signer = alias(staff, "signer");

const QUOTE_ROW = {
  q: mortgageQuote,
  officerName: staff.characterName,
  mortgageAddress: mortgage.address,
  approvedByName: approver.characterName,
  confirmedByName: confirmer.characterName,
  signedByName: signer.characterName,
};

const toQuoteRow = ({ q, ...names }: { q: Quote; officerName: string | null; mortgageAddress: string | null; approvedByName: string | null; confirmedByName: string | null; signedByName: string | null }): QuoteRow => ({
  ...q,
  ...names,
});

export async function listQuotes(viewer: Viewer, filter: { mine?: boolean; status?: QuoteStatus | "live" } = {}): Promise<QuoteRow[]> {
  if (!can(viewer.role, "loans.originate")) throw new ForbiddenError();
  const rows = await db
    .select(QUOTE_ROW)
    .from(mortgageQuote)
    .leftJoin(staff, eq(staff.id, mortgageQuote.officerStaffId))
    .leftJoin(approver, eq(approver.id, mortgageQuote.approvedByStaffId))
    .leftJoin(confirmer, eq(confirmer.id, mortgageQuote.confirmedByStaffId))
    .leftJoin(signer, eq(signer.id, mortgageQuote.signedByStaffId))
    .leftJoin(mortgage, eq(mortgage.id, mortgageQuote.mortgageId))
    .where(and(filter.mine ? eq(mortgageQuote.officerStaffId, viewer.staffId) : undefined, filter.status === "live" ? inArray(mortgageQuote.status, [...LIVE_QUOTE_STATUSES]) : filter.status ? eq(mortgageQuote.status, filter.status) : undefined))
    .orderBy(desc(mortgageQuote.createdAt))
    .limit(300);
  return rows.map(toQuoteRow);
}

export async function getQuote(viewer: Viewer, id: string): Promise<QuoteRow | null> {
  if (!can(viewer.role, "loans.originate")) throw new ForbiddenError();
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const [r] = await db
    .select(QUOTE_ROW)
    .from(mortgageQuote)
    .leftJoin(staff, eq(staff.id, mortgageQuote.officerStaffId))
    .leftJoin(approver, eq(approver.id, mortgageQuote.approvedByStaffId))
    .leftJoin(confirmer, eq(confirmer.id, mortgageQuote.confirmedByStaffId))
    .leftJoin(signer, eq(signer.id, mortgageQuote.signedByStaffId))
    .leftJoin(mortgage, eq(mortgage.id, mortgageQuote.mortgageId))
    .where(eq(mortgageQuote.id, id));
  return r ? toQuoteRow(r) : null;
}

export { quoteChecks, quoteMortgage };

/**
 * Called by the mortgage sync: an open quote meets the mortgage it became — same buyer,
 * and the same loan amount or address, originated from the day before the quote to 30
 * days after. Each mortgage takes one quote.
 */
export async function matchQuotes(tx: Tx): Promise<number> {
  const open = await tx.select().from(mortgageQuote).where(inArray(mortgageQuote.status, [...LIVE_QUOTE_STATUSES])).orderBy(mortgageQuote.createdAt);
  if (!open.length) return 0;
  const taken = new Set((await tx.execute<{ id: string }>(sql`select mortgage_id as id from mortgage_quote where mortgage_id is not null`)).rows.map((r) => r.id));
  let n = 0;
  for (const q of open) {
    const loanCents = quoteMortgage(inputOf(q)).loanCents;
    const from = new Date(q.createdAt.getTime() - 86_400_000);
    const to = new Date(Math.max(q.createdAt.getTime(), q.expectedSigningAt?.getTime() ?? 0) + 30 * 86_400_000);
    const candidates = (
      await tx.execute<{ id: string }>(sql`
        select id from mortgage where merged_into_id is null and buyer_state_id = ${q.buyerStateId}
           and originated_at between ${from} and ${to}
           and (loan_cents = ${loanCents} or lower(address) = lower(${q.address}) or lower(${q.address}) = any(select lower(a) from unnest(address_aliases) a))
         order by originated_at`)
    ).rows.filter((m) => !taken.has(m.id) && !q.excludedMortgageIds.includes(m.id));
    if (!candidates.length) continue;
    taken.add(candidates[0].id);
    n++;
    await tx.update(mortgageQuote).set({ status: "matched", mortgageId: candidates[0].id, matchedAt: new Date(), updatedAt: new Date() }).where(eq(mortgageQuote.id, q.id));
  }
  return n;
}

/** The quote a mortgage was made from, if the viewer may see it. */
export async function quoteForMortgage(viewer: Viewer, mortgageId: string): Promise<{ id: string; number: number } | null> {
  if (!can(viewer.role, "loans.originate")) return null;
  const [q] = await db.select({ id: mortgageQuote.id, number: mortgageQuote.number }).from(mortgageQuote).where(eq(mortgageQuote.mortgageId, mortgageId));
  return q ?? null;
}

/*
 * Correcting the automatic match (owner review, 2026-10-11): unlink a wrong mortgage ("not
 * this one" — remembered, so the sync never pairs them again) and link the right one by hand.
 * The quote's officer or management only; audited with a reason.
 */
export const unlinkQuoteSchema = z.object({ id: z.uuid(), reason: z.string().trim().min(5, "Give a reason (at least 5 characters).").max(500) });
export const linkQuoteSchema = z.object({ id: z.uuid(), mortgageId: z.uuid(), reason: z.string().trim().min(5, "Give a reason (at least 5 characters).").max(500) });

export async function unlinkQuote(viewer: Viewer, raw: z.input<typeof unlinkQuoteSchema>): Promise<void> {
  const { id, reason } = unlinkQuoteSchema.parse(raw);
  const request = await getRequestMeta();
  await db.transaction(async (tx) => {
    const [q] = await tx.select().from(mortgageQuote).where(eq(mortgageQuote.id, id)).for("update");
    if (!q) throw new LoanError("Quote not found.");
    if (!canActOnQuote(viewer, q)) throw new ForbiddenError("Only the quote’s officer or management can change it.");
    if (q.status !== "matched" || !q.mortgageId) throw new LoanError("This quote isn't linked to a mortgage.");
    await tx
      .update(mortgageQuote)
      .set({ status: "draft", mortgageId: null, matchedAt: null, confirmedAt: null, confirmedByStaffId: null, signedAt: null, signedByStaffId: null, excludedMortgageIds: [...new Set([...q.excludedMortgageIds, q.mortgageId])], updatedAt: new Date() })
      .where(eq(mortgageQuote.id, id));
    await recordAudit(tx, {
      actor: { type: "staff", staffId: viewer.staffId },
      action: "mortgages.quote.unlinked",
      target: { type: "mortgage_quote", id },
      reason,
      metadata: { number: q.number, mortgageId: q.mortgageId },
      request,
    });
  });
}

export type MortgageCandidate = { id: string; address: string; loanCents: number | null; originatedAt: Date | null; linkedQuoteNumber: number | null };

/** The buyer's mortgages, newest first, with any quote each is already linked to. */
export async function mortgageCandidates(viewer: Viewer, quoteId: string): Promise<MortgageCandidate[]> {
  if (!can(viewer.role, "loans.originate")) throw new ForbiddenError();
  const [q] = await db.select().from(mortgageQuote).where(eq(mortgageQuote.id, quoteId));
  if (!q) return [];
  return db
    .select({ id: mortgage.id, address: mortgage.address, loanCents: mortgage.loanCents, originatedAt: mortgage.originatedAt, linkedQuoteNumber: mortgageQuote.number })
    .from(mortgage)
    .leftJoin(mortgageQuote, eq(mortgageQuote.mortgageId, mortgage.id))
    .where(and(eq(mortgage.buyerStateId, q.buyerStateId), isNull(mortgage.mergedIntoId)))
    .orderBy(desc(mortgage.originatedAt));
}

export async function linkQuote(viewer: Viewer, raw: z.input<typeof linkQuoteSchema>): Promise<void> {
  const { id, mortgageId, reason } = linkQuoteSchema.parse(raw);
  const request = await getRequestMeta();
  await db.transaction(async (tx) => {
    const [q] = await tx.select().from(mortgageQuote).where(eq(mortgageQuote.id, id)).for("update");
    if (!q) throw new LoanError("Quote not found.");
    if (!canActOnQuote(viewer, q)) throw new ForbiddenError("Only the quote’s officer or management can change it.");
    if (!isLiveQuote(q.status)) throw new LoanError("Only a draft or confirmed quote can be linked to a mortgage.");
    const [m] = await tx.select().from(mortgage).where(and(eq(mortgage.id, mortgageId), isNull(mortgage.mergedIntoId)));
    if (!m || m.buyerStateId !== q.buyerStateId) throw new LoanError("That mortgage isn't this buyer's.");
    const [other] = await tx.select({ number: mortgageQuote.number }).from(mortgageQuote).where(eq(mortgageQuote.mortgageId, mortgageId));
    if (other) throw new LoanError(`That mortgage is already linked to quote #${other.number}. Unlink it there first.`);
    await tx
      .update(mortgageQuote)
      .set({ status: "matched", mortgageId, matchedAt: new Date(), excludedMortgageIds: q.excludedMortgageIds.filter((x) => x !== mortgageId), updatedAt: new Date() })
      .where(eq(mortgageQuote.id, id));
    await recordAudit(tx, {
      actor: { type: "staff", staffId: viewer.staffId },
      action: "mortgages.quote.linked",
      target: { type: "mortgage_quote", id },
      reason,
      metadata: { number: q.number, mortgageId, address: m.address },
      request,
    });
  });
}
