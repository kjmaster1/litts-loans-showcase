import "server-only";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { CATEGORIES, categoryAllows, isCategory, type Category } from "@/domain/ledger/categories";
import { postingLines, reverseLines } from "@/domain/ledger/posting";
import { ForbiddenError } from "@/lib/permissions";
import { recordAudit } from "@/server/audit/audit";
import type { Viewer } from "@/server/authz/viewer";
import { db } from "@/server/db";
import { bankTransaction, journalEntry, journalLine, loanPaymentLink } from "@/server/db/schema";
import { syncPayouts } from "@/server/commissions/service";
import { syncLoans } from "@/server/loans/sync";
import { syncMortgages } from "@/server/mortgages/sync";
import { activeFeeLink } from "@/server/legal/fees";
import { getRequestMeta } from "@/server/request";

/**
 * Changes a bank row's category. The ledger is never edited: the existing
 * posting is reversed and a new posting made, both dated at the transaction's
 * time so historical reports stay correct. Caller must hold `bank.reclassify`.
 */
export async function reclassifyTransaction(viewer: Viewer, input: { transactionId: string; category: string; reason: string }) {
  if (!isCategory(input.category) || !CATEGORIES[input.category].selectable) {
    throw new ForbiddenError("That category can't be chosen manually.");
  }
  const category: Category = input.category;
  const request = await getRequestMeta();

  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(bankTransaction).where(eq(bankTransaction.id, input.transactionId)).for("update");
    if (!row) throw new ForbiddenError("Transaction not found.");
    const current = row.category as Category;
    if (!CATEGORIES[current].selectable && current !== "unclassified") {
      throw new ForbiddenError("Game-generated mortgage and tax records can't be reclassified.");
    }
    if (current === category) throw new ForbiddenError("It's already in that category.");
    if (!categoryAllows(category, row.direction)) {
      throw new ForbiddenError(`"${CATEGORIES[category].label}" doesn't apply to money ${row.direction === "in" ? "coming in" : "going out"}.`);
    }
    const [linked] = await tx.select({ loanId: loanPaymentLink.loanId }).from(loanPaymentLink).where(eq(loanPaymentLink.bankTransactionId, row.id));
    if (linked) throw new ForbiddenError("This payment is part of a loan's record, so it can't be reclassified.");
    if (await activeFeeLink(tx, row.id)) throw new ForbiddenError("This payment is a legal case's attorney & filing fee, so it can't be reclassified. Unlink it on the case first.");
    if (!row.postingEntryId) throw new Error(`bank_transaction ${row.id} has no posting entry`);

    const oldLines = await tx.select().from(journalLine).where(eq(journalLine.entryId, row.postingEntryId));
    const reversalId = randomUUID();
    const newEntryId = randomUUID();
    const label = CATEGORIES[category].label;

    await tx.insert(journalEntry).values([
      {
        id: reversalId,
        effectiveAt: row.occurredAt,
        kind: "reversal",
        description: `Reversal (reclassified to ${label})`,
        bankTransactionId: row.id,
        reversesEntryId: row.postingEntryId,
        createdByStaffId: viewer.staffId,
        reason: input.reason,
      },
      {
        id: newEntryId,
        effectiveAt: row.occurredAt,
        kind: "bank_posting",
        description: row.comment.trim().slice(0, 300) || row.txType,
        bankTransactionId: row.id,
        createdByStaffId: viewer.staffId,
        reason: input.reason,
      },
    ]);
    const reversed = reverseLines(
      oldLines.map((l) => ({ account: l.accountCode, debit: l.debitCents, credit: l.creditCents, memo: l.memo ?? undefined })),
    );
    const fresh = postingLines({ direction: row.direction, amountCents: row.amountCents, taxCents: row.taxCents, category });
    await tx.insert(journalLine).values([
      ...reversed.map((l) => ({ entryId: reversalId, accountCode: l.account, debitCents: l.debit, creditCents: l.credit, memo: l.memo ?? null })),
      ...fresh.map((l) => ({ entryId: newEntryId, accountCode: l.account, debitCents: l.debit, creditCents: l.credit, memo: l.memo ?? null })),
    ]);
    await tx
      .update(bankTransaction)
      .set({ category, confidence: "manual", classifiedByStaffId: viewer.staffId, postingEntryId: newEntryId })
      .where(eq(bankTransaction.id, row.id));

    await recordAudit(tx, {
      actor: { type: "staff", staffId: viewer.staffId },
      action: "bank.transaction.reclassified",
      target: { type: "bank_transaction", id: row.id },
      reason: input.reason,
      metadata: { from: current, to: category, amountCents: row.amountCents, direction: row.direction },
      request,
    });
    // A row moved into a loan, mortgage or commission category is linked straight away — the
    // same syncs an import runs. (Pages used to catch up on load; they no longer write.)
    await syncLoans(tx);
    await syncMortgages(tx);
    await syncPayouts(tx);
  });
}
