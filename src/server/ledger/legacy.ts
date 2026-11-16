import "server-only";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { can, ForbiddenError } from "@/lib/permissions";
import { recordAudit } from "@/server/audit/audit";
import { requireFreshStepUp } from "@/server/auth/step-up-guard";
import type { Viewer } from "@/server/authz/viewer";
import { db, type Db, type Tx } from "@/server/db";
import { bankTransaction, journalEntry, journalLine } from "@/server/db/schema";
import { LoanError } from "@/server/loans/errors";
import { groupLegacyLoans } from "@/domain/ledger/legacy-loans";
import { getRequestMeta } from "@/server/request";

/**
 * The 2025–2026 manual loans (docs/research/09). Their disbursements and
 * repayments run through clearing account 1190; once they are all finished the
 * balance left there is their net result: income (4020) if more came back than
 * was lent, a credit loss (5300) otherwise.
 */

const LEGACY = ["legacy_loan.disbursement", "legacy_loan.repayment"];

export type LegacyClearing = {
  /** Debit-positive balance of 1190 (negative = more repaid than lent). */
  balanceCents: number;
  lentCents: number;
  repaidCents: number;
  lastActivity: Date | null;
  /** Income already booked to 4020 by an earlier close-out. */
  bookedIncomeCents: number;
};

export async function legacyClearing(executor: Db | Tx = db): Promise<LegacyClearing> {
  const [bal] = (await executor.execute<{ b: string }>(sql`select coalesce(sum(debit_cents - credit_cents), 0) as b from journal_line where account_code = '1190'`)).rows;
  const [booked] = (await executor.execute<{ b: string }>(sql`select coalesce(sum(credit_cents - debit_cents), 0) as b from journal_line where account_code = '4020'`)).rows;
  const rows = await executor
    .select({
      category: bankTransaction.category,
      total: sql<string>`sum(${bankTransaction.amountCents})`,
      last: sql<Date | null>`max(${bankTransaction.occurredAt})`,
    })
    .from(bankTransaction)
    .where(inArray(bankTransaction.category, LEGACY))
    .groupBy(bankTransaction.category);
  const total = (c: string) => Number(rows.find((r) => r.category === c)?.total ?? 0);
  const lasts = rows.map((r) => (r.last ? new Date(r.last) : null)).filter((d): d is Date => d !== null);
  return {
    balanceCents: Number(bal.b),
    lentCents: total("legacy_loan.disbursement"),
    repaidCents: total("legacy_loan.repayment"),
    lastActivity: lasts.length ? new Date(Math.max(...lasts.map((d) => d.getTime()))) : null,
    bookedIncomeCents: Number(booked.b),
  };
}

export const closeLegacySchema = z.object({ reason: z.string().trim().min(5, "Give a reason (at least 5 characters).").max(500) });

/** Books what's left in 1190 as the old loans' result. Sensitive: fresh 2FA + reason. */
export async function closeLegacyClearing(viewer: Viewer, raw: z.input<typeof closeLegacySchema>): Promise<{ entryId: string; amountCents: number }> {
  if (!can(viewer.role, "ledger.adjust")) throw new ForbiddenError();
  requireFreshStepUp(viewer);
  const input = closeLegacySchema.parse(raw);
  const request = await getRequestMeta();

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${0x4c4c4c47})`); // "LLLG"
    const c = await legacyClearing(tx);
    if (c.balanceCents === 0) throw new LoanError("There's nothing left to book: the old loans' clearing account is already at zero.");
    const entryId = randomUUID();
    const income = c.balanceCents < 0;
    const amount = Math.abs(c.balanceCents);
    // A debit left after an earlier close-out means repayments were moved out of
    // 1190 since (e.g. a recovery that had been filed as an old-loan repayment):
    // take it back out of the income booked then, before calling anything a loss.
    const fromIncome = income ? 0 : Math.min(amount, Math.max(0, c.bookedIncomeCents));
    const loss = income ? 0 : amount - fromIncome;
    // A correction is dated with the close-out it corrects, so monthly P&L stays like-for-like.
    const [{ closedAt }] = (
      await tx.execute<{ closedAt: Date | null }>(sql`select max(e.effective_at) as "closedAt" from journal_entry e join journal_line l on l.entry_id = e.id where l.account_code = '4020' and l.credit_cents > 0`)
    ).rows;
    await tx.insert(journalEntry).values({
      id: entryId,
      effectiveAt: fromIncome && closedAt ? new Date(closedAt) : (c.lastActivity ?? new Date()),
      kind: "adjustment",
      description: fromIncome ? "Old manual loans close-out corrected" : "Old manual loans closed out",
      createdByStaffId: viewer.staffId,
      reason: input.reason,
    });
    await tx.insert(journalLine).values(
      income
        ? [
            { entryId, accountCode: "1190", debitCents: amount, creditCents: 0, memo: "Old manual loans: repaid beyond what was lent" },
            { entryId, accountCode: "4020", debitCents: 0, creditCents: amount, memo: "Old manual loans: repaid beyond what was lent" },
          ]
        : [
            ...(fromIncome ? [{ entryId, accountCode: "4020", debitCents: fromIncome, creditCents: 0, memo: "Old manual loans: repayments moved out since the close-out" }] : []),
            ...(loss ? [{ entryId, accountCode: "5300", debitCents: loss, creditCents: 0, memo: "Old manual loans: lent and never repaid" }] : []),
            { entryId, accountCode: "1190", debitCents: 0, creditCents: amount, memo: "Old manual loans closed out" },
          ],
    );
    await recordAudit(tx, {
      actor: { type: "staff", staffId: viewer.staffId },
      action: "ledger.legacy_loans.closed",
      target: { type: "journal_entry", id: entryId },
      reason: input.reason,
      metadata: { amountCents: amount, as: income ? "4020 income" : fromIncome && !loss ? "4020 income reduced" : fromIncome ? "4020 income reduced + 5300 credit loss" : "5300 credit loss", fromIncomeCents: fromIncome, lossCents: loss, lentCents: c.lentCents, repaidCents: c.repaidCents },
      request,
    });
    return { entryId, amountCents: amount };
  });
}

export type RestatedLoan = { number: number; label: string; resultCents: number; closedAt: Date };

/**
 * Books each old manual loan's result in the month it finished, instead of one lump
 * (audit F7, owner 2026-10-10). The earlier close-out entries are reversed (never
 * edited); each loan then gets its own entry — profit Dr 1190 / Cr 4020, loss Dr 5300 /
 * Cr 1190 — dated at its last bank row. Refuses if any row can't be placed or the
 * totals don't tie. Sensitive: fresh 2FA + reason. `overrides` place rows the comment
 * rules can't (see domain/ledger/legacy-loans.ts).
 */
export async function restateLegacyByLoan(
  viewer: Viewer,
  raw: z.input<typeof closeLegacySchema> & { overrides?: { pattern: RegExp; loan: number }[]; dryRun?: boolean },
): Promise<{ loans: RestatedLoan[]; reversed: number }> {
  if (!can(viewer.role, "ledger.adjust")) throw new ForbiddenError();
  requireFreshStepUp(viewer);
  const input = closeLegacySchema.parse({ reason: raw.reason });
  const request = await getRequestMeta();

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${0x4c4c4c47})`);
    const rows = await tx
      .select({
        id: bankTransaction.id,
        occurredAt: bankTransaction.occurredAt,
        direction: bankTransaction.direction,
        amountCents: bankTransaction.amountCents,
        comment: bankTransaction.comment,
        sourceWallet: bankTransaction.sourceWallet,
        targetWallet: bankTransaction.targetWallet,
      })
      .from(bankTransaction)
      .where(inArray(bankTransaction.category, LEGACY));
    const { loans, unplaced } = groupLegacyLoans(rows, raw.overrides ?? []);
    if (unplaced.length) throw new LoanError(`Can't place ${unplaced.length} old-loan row(s): ${unplaced.map((r) => r.comment.slice(0, 40)).join("; ")}`);

    // The manual close-out entries still standing (not reversed, not reversals).
    const closeOuts = await tx.execute<{ id: string }>(sql`
      select distinct e.id from journal_entry e join journal_line l on l.entry_id = e.id
       where l.account_code = '1190' and e.kind = 'adjustment' and e.bank_transaction_id is null
         and not exists (select 1 from journal_entry r where r.reverses_entry_id = e.id)`);
    const [{ booked }] = (
      await tx.execute<{ booked: string }>(sql`
        select coalesce(sum(l.debit_cents - l.credit_cents), 0) as booked from journal_line l where l.account_code = '1190'
           and l.entry_id in (select e.id from journal_entry e where e.kind = 'adjustment' and e.bank_transaction_id is null
                                and not exists (select 1 from journal_entry r where r.reverses_entry_id = e.id))`)
    ).rows;
    const total = loans.reduce((s, l) => s + l.resultCents, 0);
    // The close-outs moved exactly the loans' net result out of 1190.
    if (Number(booked) !== total) throw new LoanError(`Totals don't tie: close-outs ${Number(booked) / 100} vs loans ${total / 100}.`);
    const result = { loans: loans.map(({ number, label, resultCents, closedAt }) => ({ number, label, resultCents, closedAt })), reversed: closeOuts.rows.length };
    if (raw.dryRun) return result;

    for (const { id } of closeOuts.rows) {
      const lines = await tx.select().from(journalLine).where(eq(journalLine.entryId, id));
      const [orig] = await tx.select().from(journalEntry).where(eq(journalEntry.id, id));
      const reversalId = randomUUID();
      await tx.insert(journalEntry).values({
        id: reversalId,
        effectiveAt: orig.effectiveAt,
        kind: "reversal",
        description: "Reversal (old manual loans restated loan by loan)",
        reversesEntryId: id,
        createdByStaffId: viewer.staffId,
        reason: input.reason,
      });
      await tx.insert(journalLine).values(lines.map((l) => ({ entryId: reversalId, accountCode: l.accountCode, debitCents: l.creditCents, creditCents: l.debitCents, memo: l.memo })));
    }
    for (const l of loans) {
      if (l.resultCents === 0) continue;
      const entryId = randomUUID();
      const profit = l.resultCents > 0;
      const memo = `Old manual loan #${l.number}: ${profit ? "repaid beyond what was lent" : "lent and not repaid"}`;
      await tx.insert(journalEntry).values({
        id: entryId,
        effectiveAt: l.closedAt,
        kind: "adjustment",
        description: `Old manual loan #${l.number} closed out`,
        createdByStaffId: viewer.staffId,
        reason: input.reason,
      });
      const amount = Math.abs(l.resultCents);
      await tx.insert(journalLine).values(
        profit
          ? [
              { entryId, accountCode: "1190", debitCents: amount, creditCents: 0, memo },
              { entryId, accountCode: "4020", debitCents: 0, creditCents: amount, memo },
            ]
          : [
              { entryId, accountCode: "5300", debitCents: amount, creditCents: 0, memo },
              { entryId, accountCode: "1190", debitCents: 0, creditCents: amount, memo },
            ],
      );
    }
    const [{ bal }] = (await tx.execute<{ bal: string }>(sql`select coalesce(sum(debit_cents - credit_cents), 0) as bal from journal_line where account_code = '1190'`)).rows;
    if (Number(bal) !== 0) throw new Error(`1190 not zero after restating: ${bal}`);
    await recordAudit(tx, {
      actor: { type: "staff", staffId: viewer.staffId },
      action: "ledger.legacy_loans.restated",
      target: { type: "ledger", id: "1190" },
      reason: input.reason,
      metadata: { loans: loans.length, reversed: closeOuts.rows.length, profitCents: loans.filter((l) => l.resultCents > 0).reduce((s, l) => s + l.resultCents, 0), lossCents: loans.filter((l) => l.resultCents < 0).reduce((s, l) => s - l.resultCents, 0) },
      request,
    });
    return result;
  });
}
