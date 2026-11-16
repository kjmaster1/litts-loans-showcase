import "server-only";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { quoteApproval } from "@/domain/mortgages/approval";
import { quoteMortgage } from "@/domain/origination/mortgage-quote";
import { isLiveQuote } from "@/domain/origination/quote-status";
import { can, ForbiddenError } from "@/lib/permissions";
import { recordAudit } from "@/server/audit/audit";
import { canActOnQuote, canApproveQuote, canReviewQuote } from "@/server/authz/rules";
import type { Viewer } from "@/server/authz/viewer";
import { db, type Tx } from "@/server/db";
import { mortgageQuote, mortgageQuoteNote, staff } from "@/server/db/schema";
import { LoanError } from "@/server/loans/errors";
import { getRequestMeta } from "@/server/request";
import { getSettings } from "@/server/settings";
import { inputOf } from "./mortgage-quotes";

/**
 * Reviewing quotes (owner, 2026-10-15; research/18). Management leave a note saying what needs
 * changing instead of changing a colleague's quote themselves; the officer (or management) marks
 * it done, optionally with a reply. Executives approve quotes over the executive-approval line.
 * Notes are append-only: "done" is a second row that resolves the first.
 */

export const addQuoteNoteSchema = z.object({ quoteId: z.uuid(), text: z.string().trim().min(3, "Say what needs changing.").max(1000) });
export const resolveQuoteNoteSchema = z.object({ noteId: z.uuid(), reply: z.string().trim().max(300).default("") });
export const approveQuoteSchema = z.object({ id: z.uuid() });

async function lockQuote(tx: Tx, id: string) {
  const [q] = await tx.select().from(mortgageQuote).where(eq(mortgageQuote.id, id)).for("update");
  if (!q) throw new LoanError("Quote not found.");
  return q;
}

export async function addQuoteNote(viewer: Viewer, raw: z.input<typeof addQuoteNoteSchema>): Promise<void> {
  const { quoteId, text } = addQuoteNoteSchema.parse(raw);
  const request = await getRequestMeta();
  await db.transaction(async (tx) => {
    const q = await lockQuote(tx, quoteId);
    if (!canReviewQuote(viewer, q)) throw new ForbiddenError("Only management can leave review notes on a colleague’s quote.");
    if (!isLiveQuote(q.status)) throw new LoanError("This quote is closed.");
    const [note] = await tx.insert(mortgageQuoteNote).values({ quoteId, staffId: viewer.staffId, text }).returning({ id: mortgageQuoteNote.id });
    await recordAudit(tx, {
      actor: { type: "staff", staffId: viewer.staffId },
      action: "mortgages.quote.note_added",
      target: { type: "mortgage_quote", id: quoteId },
      metadata: { number: q.number, noteId: note.id, text },
      request,
    });
  });
}

export async function resolveQuoteNote(viewer: Viewer, raw: z.input<typeof resolveQuoteNoteSchema>): Promise<void> {
  const { noteId, reply } = resolveQuoteNoteSchema.parse(raw);
  const request = await getRequestMeta();
  await db.transaction(async (tx) => {
    const [note] = await tx.select().from(mortgageQuoteNote).where(eq(mortgageQuoteNote.id, noteId));
    if (!note || note.resolvesId) throw new LoanError("Note not found.");
    const q = await lockQuote(tx, note.quoteId);
    if (!canActOnQuote(viewer, q)) throw new ForbiddenError("Only the quote’s officer or management can mark its notes done.");
    if (!isLiveQuote(q.status)) throw new LoanError("This quote is closed.");
    // The quote's row lock serialises this check; the unique index backs it up.
    const [done] = await tx.select({ id: mortgageQuoteNote.id }).from(mortgageQuoteNote).where(eq(mortgageQuoteNote.resolvesId, noteId));
    if (done) throw new LoanError("That note is already done.");
    await tx.insert(mortgageQuoteNote).values({ quoteId: q.id, resolvesId: noteId, staffId: viewer.staffId, text: reply });
    await recordAudit(tx, {
      actor: { type: "staff", staffId: viewer.staffId },
      action: "mortgages.quote.note_resolved",
      target: { type: "mortgage_quote", id: q.id },
      metadata: { number: q.number, noteId, reply },
      request,
    });
  });
}

export async function approveQuote(viewer: Viewer, raw: z.input<typeof approveQuoteSchema>): Promise<void> {
  const { id } = approveQuoteSchema.parse(raw);
  if (!canApproveQuote(viewer)) throw new ForbiddenError("Only an executive can approve a large mortgage.");
  const g = (await getSettings()).mortgages;
  const request = await getRequestMeta();
  await db.transaction(async (tx) => {
    const q = await lockQuote(tx, id);
    if (!isLiveQuote(q.status)) throw new LoanError("This quote is closed.");
    const state = quoteApproval({ baseCents: quoteMortgage(inputOf(q)).baseCents, approvedAt: q.approvedAt }, g);
    if (state === "not_needed") throw new LoanError("This quote doesn’t need an executive’s approval.");
    if (state === "approved") throw new LoanError("This quote is already approved.");
    const now = new Date();
    await tx.update(mortgageQuote).set({ approvedAt: now, approvedByStaffId: viewer.staffId, updatedAt: now }).where(eq(mortgageQuote.id, id));
    await recordAudit(tx, {
      actor: { type: "staff", staffId: viewer.staffId },
      action: "mortgages.quote.approved",
      target: { type: "mortgage_quote", id },
      metadata: { number: q.number, address: q.address, buyerStateId: q.buyerStateId, baseCents: quoteMortgage(inputOf(q)).baseCents },
      request,
    });
  });
}

export type QuoteNote = {
  id: string;
  text: string;
  at: Date;
  staffId: string;
  staffName: string | null;
  done: { at: Date; staffName: string | null; reply: string } | null;
};

/** A quote's review notes, oldest first, each with its resolution if it's done. */
export async function quoteNotes(viewer: Viewer, quoteId: string): Promise<QuoteNote[]> {
  if (!can(viewer.role, "loans.originate")) throw new ForbiddenError();
  const rows = await db
    .select({ n: mortgageQuoteNote, staffName: staff.characterName })
    .from(mortgageQuoteNote)
    .leftJoin(staff, eq(staff.id, mortgageQuoteNote.staffId))
    .where(eq(mortgageQuoteNote.quoteId, quoteId))
    .orderBy(asc(mortgageQuoteNote.at));
  const resolutions = new Map(rows.filter((r) => r.n.resolvesId).map((r) => [r.n.resolvesId!, r]));
  return rows
    .filter((r) => !r.n.resolvesId)
    .map((r) => {
      const d = resolutions.get(r.n.id);
      return { id: r.n.id, text: r.n.text, at: r.n.at, staffId: r.n.staffId, staffName: r.staffName, done: d ? { at: d.n.at, staffName: d.staffName, reply: d.n.text } : null };
    });
}

/** Open (not done) review notes per quote, for the list's badge. */
export async function openNoteCounts(quoteIds: string[]): Promise<Map<string, number>> {
  if (!quoteIds.length) return new Map();
  const done = alias(mortgageQuoteNote, "done");
  const rows = await db
    .select({ quoteId: mortgageQuoteNote.quoteId })
    .from(mortgageQuoteNote)
    .leftJoin(done, eq(done.resolvesId, mortgageQuoteNote.id))
    .where(and(inArray(mortgageQuoteNote.quoteId, quoteIds), isNull(mortgageQuoteNote.resolvesId), isNull(done.id)));
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.quoteId, (out.get(r.quoteId) ?? 0) + 1);
  return out;
}
