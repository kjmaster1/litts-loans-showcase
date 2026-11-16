import "server-only";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Category } from "@/domain/ledger/categories";
import { deriveLoans, linkPayments, type LinkableRow, type LinkMethod } from "@/domain/loans/link";
import { finalInstalment, instalmentsFromComment, matchCards, type CandidateLoan } from "@/domain/loans/match";
import type { LoanCard } from "@/domain/loans/parse-cards";
import { statusFromCard, type LoanTab } from "@/domain/loans/status";
import { can, ForbiddenError } from "@/lib/permissions";
import { recordAudit } from "@/server/audit/audit";
import type { Viewer } from "@/server/authz/viewer";
import { db, type Tx } from "@/server/db";
import { bankTransaction, liveLoan, loan, loanCard, loanEvent, loanPaste, loanPaymentLink } from "@/server/db/schema";
import { getRequestMeta } from "@/server/request";
import { LoanError } from "./errors";
import { syncLoans } from "./sync";

/**
 * Payments are linked to loans once and never moved automatically. When the
 * matcher improves — or a borrower had two loans at once and it guessed wrong —
 * this compares today's matcher with the stored links and lets Management+
 * apply the difference (docs/design/LOANS.md §Corrections).
 */

const LOAN_CATEGORIES: Category[] = [
  "loan.disbursement",
  "loan.origination_fee",
  "loan.principal",
  "loan.interest",
  "loan.early_principal",
  "loan.early_interest",
  "loan.late_principal",
  "loan.late_fee",
];

export type Move = {
  txId: string;
  at: Date;
  role: string;
  amountCents: number;
  comment: string;
  fromLoanId: string;
  toLoanId: string;
  method: LinkMethod;
};

async function rowsFor(executor: typeof db | Tx, stateId?: number): Promise<LinkableRow[]> {
  const rows = await executor
    .select({
      id: bankTransaction.id,
      occurredAt: bankTransaction.occurredAt,
      category: bankTransaction.category,
      comment: bankTransaction.comment,
      amountCents: bankTransaction.amountCents,
      initiatorStateId: bankTransaction.initiatorStateId,
    })
    .from(bankTransaction)
    .where(
      stateId === undefined
        ? inArray(bankTransaction.category, LOAN_CATEGORIES)
        : and(inArray(bankTransaction.category, LOAN_CATEGORIES), eq(bankTransaction.initiatorStateId, stateId)),
    );
  return rows.map((r) => ({ ...r, category: r.category as Category }));
}

/** Where today's matcher would put each already-linked payment, where that differs. */
async function computeMoves(executor: typeof db | Tx, stateId?: number): Promise<Move[]> {
  const rows = await rowsFor(executor, stateId);
  const { links } = linkPayments(rows, deriveLoans(rows));
  const byTx = new Map(rows.map((r) => [r.id, r]));
  const current = await executor
    .select({ txId: loanPaymentLink.bankTransactionId, loanId: loanPaymentLink.loanId, role: loanPaymentLink.role, recovery: loanPaymentLink.recoveryEntryId })
    .from(loanPaymentLink)
    .where(inArray(loanPaymentLink.bankTransactionId, rows.map((r) => r.id)));
  const loans = await executor.select({ id: loan.id, disbursementTxId: loan.disbursementTxId, status: loan.status }).from(loan).where(isNotNull(loan.disbursementTxId));
  const loanByDisbursement = new Map(loans.map((l) => [l.disbursementTxId!, l]));
  const statusOf = new Map(loans.map((l) => [l.id, l.status]));
  const now = new Map(current.map((c) => [c.txId, c]));

  const moves: Move[] = [];
  for (const l of links) {
    if (l.role === "disbursement") continue;
    const was = now.get(l.txId);
    const target = loanByDisbursement.get(l.disbursementTxId);
    if (!was || !target || was.loanId === target.id) continue;
    // A written-off loan's books are settled; its payments stay put.
    if (was.recovery || statusOf.get(was.loanId) === "written_off" || target.status === "written_off") continue;
    const r = byTx.get(l.txId)!;
    moves.push({ txId: l.txId, at: r.occurredAt, role: l.role, amountCents: r.amountCents, comment: r.comment, fromLoanId: was.loanId, toLoanId: target.id, method: l.method });
  }
  return moves.sort((a, b) => a.at.getTime() - b.at.getTime());
}

export async function proposeRelink(stateId: number): Promise<Move[]> {
  return computeMoves(db, stateId);
}

/** Borrowers whose stored payments differ from what the matcher would do today. */
export async function relinkSuggestions(): Promise<{ stateId: number; name: string | null; moves: number; loanId: string }[]> {
  const moves = await computeMoves(db);
  if (moves.length === 0) return [];
  const affected = await db
    .select({ id: loan.id, stateId: loan.borrowerStateId, name: loan.borrowerName })
    .from(loan)
    .where(inArray(loan.id, [...new Set(moves.map((m) => m.fromLoanId))]));
  const by = new Map<number, { stateId: number; name: string | null; moves: number; loanId: string }>();
  for (const m of moves) {
    const l = affected.find((a) => a.id === m.fromLoanId)!;
    const entry = by.get(l.stateId) ?? { stateId: l.stateId, name: l.name, moves: 0, loanId: l.id };
    entry.moves++;
    by.set(l.stateId, entry);
  }
  return [...by.values()].sort((a, b) => b.moves - a.moves);
}

export const applyRelinkSchema = z.object({
  stateId: z.number().int().positive(),
  reason: z.string().trim().min(5, "Give a reason (at least 5 characters).").max(500),
});

/**
 * Moves the payments, re-reads the borrower's latest phone cards against the
 * corrected loans (terms and status follow the right card), and lets the sync
 * true-up the State levy and closing adjustments. Management+.
 */
export async function applyRelink(viewer: Viewer, raw: z.input<typeof applyRelinkSchema>): Promise<{ moved: number; termsCorrected: number }> {
  if (!can(viewer.role, "loans.edit_metadata")) throw new ForbiddenError();
  const input = applyRelinkSchema.parse(raw);
  const request = await getRequestMeta();

  return db.transaction(async (tx) => {
    const moves = await computeMoves(tx, input.stateId);
    if (moves.length === 0) throw new LoanError("Nothing to correct: the payments already match the loans.");
    for (const m of moves) {
      await tx.update(loanPaymentLink).set({ loanId: m.toLoanId, method: m.method }).where(eq(loanPaymentLink.bankTransactionId, m.txId));
    }
    // Payments that were already on the right loan get today's explanation of how they were identified.
    const rows = await rowsFor(tx, input.stateId);
    for (const l of linkPayments(rows, deriveLoans(rows)).links) {
      if (l.role === "disbursement") continue;
      await tx
        .update(loanPaymentLink)
        .set({ method: l.method })
        .where(and(eq(loanPaymentLink.bankTransactionId, l.txId), sql`${loanPaymentLink.method} <> ${l.method}`, sql`${loanPaymentLink.recoveryEntryId} is null`));
    }
    const termsCorrected = await rematchCards(tx, input.stateId, viewer);
    await syncLoans(tx);

    const touched = [...new Set(moves.flatMap((m) => [m.fromLoanId, m.toLoanId]))];
    for (const id of touched) {
      await tx.insert(loanEvent).values({
        loanId: id,
        kind: "payments_relinked",
        staffId: viewer.staffId,
        detail: { in: moves.filter((m) => m.toLoanId === id).length, out: moves.filter((m) => m.fromLoanId === id).length, reason: input.reason },
      });
    }
    await recordAudit(tx, {
      actor: { type: "staff", staffId: viewer.staffId },
      action: "loans.payments.relinked",
      target: { type: "borrower", id: String(input.stateId) },
      reason: input.reason,
      metadata: { moves: moves.map((m) => ({ txId: m.txId, from: m.fromLoanId, to: m.toLoanId })), termsCorrected },
      request,
    });
    return { moved: moves.length, termsCorrected };
  });
}

/** Re-matches the borrower's most recent card in each tab to their (now correctly paid) loans. */
async function rematchCards(tx: Tx, stateId: number, viewer: Viewer): Promise<number> {
  const loans = await tx.select().from(loan).where(and(liveLoan, eq(loan.borrowerStateId, stateId)));
  if (loans.length < 2) return 0;
  const ids = loans.map((l) => l.id);
  const pays = await tx
    .select({ loanId: loanPaymentLink.loanId, role: loanPaymentLink.role, amount: bankTransaction.amountCents, comment: bankTransaction.comment, at: bankTransaction.occurredAt })
    .from(loanPaymentLink)
    .innerJoin(bankTransaction, eq(bankTransaction.id, loanPaymentLink.bankTransactionId))
    .where(inArray(loanPaymentLink.loanId, ids))
    .orderBy(bankTransaction.occurredAt);
  const candidates: CandidateLoan[] = loans.map((l) => {
    const mine = pays.filter((p) => p.loanId === l.id);
    const returned = mine.filter((p) => p.role.includes("principal")).reduce((s, p) => s + p.amount, 0);
    const n = mine.filter((p) => p.role === "principal").map((p) => instalmentsFromComment(p.comment)).filter((x): x is number => x !== null);
    const amounts = [l.principalCents / 100, ...(l.brokerRateBp !== null ? [Math.round((l.principalCents / 100) * (1 + l.brokerRateBp / 10_000))] : [])];
    return {
      id: l.id,
      borrowerStateId: l.borrowerStateId,
      principalCents: l.principalCents,
      openedAt: l.openedAt ?? l.createdAt,
      observedInstalments: n.at(-1) ?? null,
      returnedRatio: returned / l.principalCents,
      paidUp: mine.some((p) => p.role === "principal" && finalInstalment(p.comment, amounts)),
    };
  });

  // The latest paste of each tab that showed this borrower.
  const cards = await tx
    .select({ id: loanCard.id, pasteId: loanCard.pasteId, loanId: loanCard.loanId, parsed: loanCard.parsed, tab: loanPaste.tab, capturedAt: loanPaste.capturedAt })
    .from(loanCard)
    .innerJoin(loanPaste, eq(loanPaste.id, loanCard.pasteId))
    .where(inArray(loanCard.loanId, ids))
    .orderBy(desc(loanPaste.capturedAt));
  const latestPaste = new Map<string, string>();
  for (const c of cards) if (!latestPaste.has(c.tab)) latestPaste.set(c.tab, c.pasteId);
  let corrected = 0;
  for (const [tab, pasteId] of latestPaste) {
    const group = cards.filter((c) => c.pasteId === pasteId);
    const parsed = group.map((c, i) => ({ ...(c.parsed as LoanCard), index: i }));
    const results = matchCards(parsed, candidates);
    for (const r of results) {
      if (r.kind !== "matched") continue;
      const card = r.card;
      const row = group[card.index];
      const l = loans.find((x) => x.id === r.loanId)!;
      const terms = {
        instalments: card.instalments ?? l.instalments,
        periodDays: card.periodDays ?? l.periodDays,
        brokerRateBp: card.brokerRatePct !== null ? Math.round(card.brokerRatePct * 100) : l.brokerRateBp,
        stateRateBp: card.stateRatePct !== null ? Math.round(card.stateRatePct * 100) : l.stateRateBp,
      };
      const changed = terms.instalments !== l.instalments || terms.brokerRateBp !== l.brokerRateBp || terms.stateRateBp !== l.stateRateBp || terms.periodDays !== l.periodDays;
      if (row.loanId !== l.id) await tx.update(loanCard).set({ loanId: l.id }).where(eq(loanCard.id, row.id));
      if (!changed && row.loanId === l.id) continue;
      await tx
        .update(loan)
        .set({
          ...terms,
          status: l.statusLocked ? l.status : statusFromCard(l.status, tab as LoanTab),
          lastCompleted: card.completed,
          lastMissed: card.missedPayments,
          lastRemainingCents: card.remainingCents,
          updatedAt: new Date(),
        })
        .where(eq(loan.id, l.id));
      if (changed) {
        corrected++;
        await tx.insert(loanEvent).values({
          loanId: l.id,
          kind: "terms_corrected",
          staffId: viewer.staffId,
          detail: { from: { instalments: l.instalments, brokerRateBp: l.brokerRateBp }, to: { instalments: terms.instalments, brokerRateBp: terms.brokerRateBp } },
        });
      }
    }
  }
  return corrected;
}
