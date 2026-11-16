import "server-only";
import { matchRecoveries, matchRefunds, RECOVERY_CATEGORIES } from "@/domain/loans/recovery";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { INSTALMENT_ROLES, levyFor, nextPaymentDue, penaltyFor } from "@/domain/loans/analysis";
import { estimateDefaultedAt, nextDueFrom } from "@/domain/loans/status";
import { deriveLoans, linkPayments, type LinkableRow, type LinkRole } from "@/domain/loans/link";
import type { Category } from "@/domain/ledger/categories";
import { db, type Tx } from "@/server/db";
import { syncLegalFees } from "@/server/legal/fees";
import { bankTransaction, journalEntry, journalLine, liveLoan, loan, loanAdjustment, loanEvent, loanPaymentLink } from "@/server/db/schema";

/**
 * Keeps the loan book consistent with the ledger (docs/design/LOANS.md).
 * Idempotent: safe to run after every bank import and card paste.
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
const PRINCIPAL_ROLES = new Set<LinkRole>(["principal", "early_principal", "late_principal"]);
/** Held by every loan sync; closing a commission week takes it too, so it never reads a half-finished import. */
export const LOAN_SYNC_LOCK = 0x4c4c4c4e; // "LLLN"
const SYNC_LOCK = LOAN_SYNC_LOCK;

async function chunked<T>(items: T[], fn: (chunk: T[]) => Promise<unknown>, size = 500) {
  for (let i = 0; i < items.length; i += size) await fn(items.slice(i, i + size));
}

export type SyncSummary = {
  loansCreated: number;
  linksCreated: number;
  levyEntries: number;
  levyCorrections: number;
  /** Overdue penalties booked as late fees, or corrected (owner 2026-10-13). */
  penaltyEntries: number;
  recoveryEntries: number;
  closingEntries: number;
};

export async function syncLoans(executor?: Tx): Promise<SyncSummary> {
  const run = async (tx: Tx): Promise<SyncSummary> => {
    await tx.execute(sql`select pg_advisory_xact_lock(${SYNC_LOCK})`);

    const bankRows = await tx
      .select({
        id: bankTransaction.id,
        occurredAt: bankTransaction.occurredAt,
        category: bankTransaction.category,
        comment: bankTransaction.comment,
        amountCents: bankTransaction.amountCents,
        initiatorStateId: bankTransaction.initiatorStateId,
        initiatorName: bankTransaction.initiatorName,
      })
      .from(bankTransaction)
      .where(inArray(bankTransaction.category, LOAN_CATEGORIES));
    const rows: LinkableRow[] = bankRows.map((r) => ({ ...r, category: r.category as Category }));
    const nameOf = new Map(bankRows.map((r) => [r.id, r.initiatorName]));

    // 1. A loan for every disbursement.
    const derived = deriveLoans(rows);
    const existing = await tx
      .select({ id: loan.id, disbursementTxId: loan.disbursementTxId, borrowerStateId: loan.borrowerStateId, principalCents: loan.principalCents, retiredAt: loan.retiredAt })
      .from(loan);
    const loanIdByDisbursement = new Map(existing.filter((l) => l.disbursementTxId).map((l) => [l.disbursementTxId!, l.id]));
    // A loan first seen on a phone card (its disbursement wasn't imported yet) adopts
    // the matching disbursement when it arrives, instead of becoming a duplicate.
    // A card-only loan retired by hand (a duplicate or a mistake) never adopts one.
    const cardOnly = existing.filter((l) => !l.disbursementTxId && !l.retiredAt);
    for (const d of derived) {
      if (loanIdByDisbursement.has(d.disbursementTxId)) continue;
      const i = cardOnly.findIndex((l) => l.borrowerStateId === d.borrowerStateId && l.principalCents === d.principalCents);
      if (i < 0) continue;
      const [adopted] = cardOnly.splice(i, 1);
      await tx
        .update(loan)
        .set({ disbursementTxId: d.disbursementTxId, openedAt: d.openedAt, updatedAt: new Date() })
        .where(eq(loan.id, adopted.id));
      await tx.insert(loanEvent).values({ loanId: adopted.id, at: d.openedAt, kind: "disbursement_linked", detail: {} });
      loanIdByDisbursement.set(d.disbursementTxId, adopted.id);
    }
    const toCreate = derived.filter((d) => !loanIdByDisbursement.has(d.disbursementTxId));
    const newLoans = toCreate.map((d) => {
      const id = randomUUID();
      loanIdByDisbursement.set(d.disbursementTxId, id);
      return {
        id,
        borrowerStateId: d.borrowerStateId,
        borrowerName: nameOf.get(d.disbursementTxId) ?? null,
        principalCents: d.principalCents,
        openedAt: d.openedAt,
        disbursementTxId: d.disbursementTxId,
        status: "active" as const,
      };
    });
    await chunked(newLoans, (c) => tx.insert(loan).values(c));
    await chunked(
      newLoans.map((l) => ({ loanId: l.id, at: l.openedAt, kind: "disbursed", detail: { principalCents: l.principalCents } })),
      (c) => tx.insert(loanEvent).values(c),
    );

    // 2. Link payments (new links only — existing links are never moved automatically).
    const { links, references } = linkPayments(rows, derived);
    const linked = new Set((await tx.select({ id: loanPaymentLink.bankTransactionId }).from(loanPaymentLink)).map((r) => r.id));
    const newLinks = links
      .filter((l) => !linked.has(l.txId))
      .map((l) => ({ bankTransactionId: l.txId, loanId: loanIdByDisbursement.get(l.disbursementTxId)!, role: l.role, method: l.method }));
    await chunked(newLinks, (c) => tx.insert(loanPaymentLink).values(c));
    for (const [ref, disbursementTxId] of references) {
      await tx
        .update(loan)
        .set({ agreementRef: ref })
        .where(and(eq(loan.disbursementTxId, disbursementTxId), isNull(loan.agreementRef)));
    }

    // 2b. Recoveries (settlements, seizures, collateral sales) that name a defaulted borrower.
    const recoveryRows = await tx
      .select({ id: bankTransaction.id, occurredAt: bankTransaction.occurredAt, comment: bankTransaction.comment })
      .from(bankTransaction)
      .where(and(inArray(bankTransaction.category, [...RECOVERY_CATEGORIES]), eq(bankTransaction.direction, "in")));
    const badLoans = await tx
      .select({ id: loan.id, borrowerName: loan.borrowerName, openedAt: loan.openedAt, firstDefaultAt: loan.firstDefaultAt })
      .from(loan)
      .where(and(liveLoan, inArray(loan.status, ["defaulted", "written_off"])));
    const recoveryLinks = matchRecoveries(
      recoveryRows.filter((r) => !linked.has(r.id)),
      badLoans,
    ).map((m) => ({ bankTransactionId: m.txId, loanId: m.loanId, role: "recovery", method: "borrower_named" }));
    await chunked(recoveryLinks, (c) => tx.insert(loanPaymentLink).values(c));

    // 2c. Refunds of game errors, to the borrower's latest loan at the time (by wallet).
    const refundRows = (
      await tx
        .select({ id: bankTransaction.id, occurredAt: bankTransaction.occurredAt, targetWallet: bankTransaction.targetWallet })
        .from(bankTransaction)
        .where(and(eq(bankTransaction.category, "loan.refund"), eq(bankTransaction.direction, "out")))
    ).filter((r) => !linked.has(r.id));
    let refundLinks: (typeof loanPaymentLink.$inferInsert)[] = [];
    if (refundRows.length) {
      const wallets = await tx.execute<{ loan_id: string; wallet: string }>(sql`
        select l.loan_id, case when b.direction = 'out' then b.target_wallet else b.source_wallet end as wallet
          from loan_payment_link l join bank_transaction b on b.id = l.bank_transaction_id
         where l.role not in ('refund', 'recovery') group by 1, 2`);
      const byLoan = new Map<string, string[]>();
      for (const w of wallets.rows) if (w.wallet) byLoan.set(w.loan_id, [...(byLoan.get(w.loan_id) ?? []), w.wallet]);
      const all = await tx.select({ id: loan.id, openedAt: loan.openedAt }).from(loan).where(liveLoan);
      refundLinks = matchRefunds(
        refundRows,
        all.map((l) => ({ ...l, wallets: byLoan.get(l.id) ?? [] })),
      ).map((m) => ({ bankTransactionId: m.txId, loanId: m.loanId, role: "refund", method: "borrower_wallet" }));
      await chunked(refundLinks, (c) => tx.insert(loanPaymentLink).values(c));
    }

    // 2b. Overdue penalties (owner 2026-10-13): the +2%-per-missed-payment part of a principal instalment is a late
    // fee (4000), not principal. Booked as the difference from what's already booked, so the same step corrects old
    // rows and books new ones. On a written-off loan the write-off was sized without it, so it goes to credit losses.
    const instalmentLinks = await tx
      .select({
        txId: loanPaymentLink.bankTransactionId,
        role: loanPaymentLink.role,
        penaltyCents: loanPaymentLink.penaltyCents,
        amountCents: bankTransaction.amountCents,
        occurredAt: bankTransaction.occurredAt,
        principalCents: loan.principalCents,
        instalments: loan.instalments,
        stateRateBp: loan.stateRateBp,
        status: loan.status,
        writtenOffAt: loan.writtenOffAt,
      })
      .from(loanPaymentLink)
      .innerJoin(bankTransaction, eq(bankTransaction.id, loanPaymentLink.bankTransactionId))
      .innerJoin(loan, eq(loan.id, loanPaymentLink.loanId))
      .where(and(inArray(loanPaymentLink.role, [...INSTALMENT_ROLES]), isNull(loanPaymentLink.recoveryEntryId)));
    const penaltyEntries: (typeof journalEntry.$inferInsert)[] = [];
    const penaltyLines: (typeof journalLine.$inferInsert)[] = [];
    const penaltyUpdates: { txId: string; penalty: number }[] = [];
    for (const p of instalmentLinks) {
      if (p.writtenOffAt && p.occurredAt >= p.writtenOffAt) continue; // a recovery (step 4)
      const penalty =
        p.instalments && p.stateRateBp !== null
          ? penaltyFor(p.role as LinkRole, p.amountCents, { principalCents: p.principalCents, instalments: p.instalments, stateRate: p.stateRateBp / 10_000 })
          : 0;
      const diff = penalty - p.penaltyCents;
      if (diff === 0) continue;
      const entryId = randomUUID();
      const receivable = p.status === "written_off" ? "5300" : "1100";
      const memo = "Overdue penalty (+2% per missed payment): a late fee, not principal";
      penaltyEntries.push({ id: entryId, effectiveAt: p.occurredAt, kind: "adjustment", description: "Overdue penalty on an instalment", bankTransactionId: p.txId });
      penaltyLines.push(
        { entryId, accountCode: diff > 0 ? receivable : "4000", debitCents: Math.abs(diff), creditCents: 0, memo },
        { entryId, accountCode: diff > 0 ? "4000" : receivable, debitCents: 0, creditCents: Math.abs(diff), memo },
      );
      penaltyUpdates.push({ txId: p.txId, penalty });
    }
    await chunked(penaltyEntries, (c) => tx.insert(journalEntry).values(c));
    await chunked(penaltyLines, (c) => tx.insert(journalLine).values(c));
    await chunked(penaltyUpdates, (c) =>
      tx.execute(sql`update loan_payment_link l set penalty_cents = v.penalty
        from (values ${sql.join(c.map((u) => sql`(${u.txId}::uuid, ${u.penalty}::bigint)`), sql`, `)}) as v(tx, penalty)
        where l.bank_transaction_id = v.tx`),
    );

    // 3 & 4. State levy (needs terms) and recoveries after write-off.
    const pending = await tx
      .select({
        txId: loanPaymentLink.bankTransactionId,
        role: loanPaymentLink.role,
        levyEntryId: loanPaymentLink.levyEntryId,
        recoveryEntryId: loanPaymentLink.recoveryEntryId,
        penaltyCents: loanPaymentLink.penaltyCents,
        amountCents: bankTransaction.amountCents,
        occurredAt: bankTransaction.occurredAt,
        loanId: loan.id,
        brokerRateBp: loan.brokerRateBp,
        stateRateBp: loan.stateRateBp,
        writtenOffAt: loan.writtenOffAt,
      })
      .from(loanPaymentLink)
      .innerJoin(bankTransaction, eq(bankTransaction.id, loanPaymentLink.bankTransactionId))
      .innerJoin(loan, eq(loan.id, loanPaymentLink.loanId))
      .where(and(inArray(loanPaymentLink.role, [...PRINCIPAL_ROLES]), isNull(loanPaymentLink.levyEntryId), isNull(loanPaymentLink.recoveryEntryId)));

    const entries: (typeof journalEntry.$inferInsert)[] = [];
    const lines: (typeof journalLine.$inferInsert)[] = [];
    const levyUpdates: { txId: string; levy: number; entryId: string }[] = [];
    const recoveryUpdates: { txId: string; entryId: string }[] = [];

    for (const p of pending) {
      const role = p.role as LinkRole;
      const entryId = randomUUID();
      if (p.writtenOffAt && p.occurredAt >= p.writtenOffAt) {
        // Money received after write-off is recovery income; the receivable stays at zero.
        entries.push({ id: entryId, effectiveAt: p.occurredAt, kind: "adjustment", description: "Recovery on written-off loan", bankTransactionId: p.txId });
        lines.push(
          { entryId, accountCode: "1100", debitCents: p.amountCents, creditCents: 0, memo: "Recovery after write-off" },
          { entryId, accountCode: "4300", debitCents: 0, creditCents: p.amountCents, memo: "Recovery after write-off" },
        );
        recoveryUpdates.push({ txId: p.txId, entryId });
        continue;
      }
      if (p.stateRateBp === null || p.brokerRateBp === null) continue; // terms unknown until a card is pasted
      const levy = levyFor(role, p.amountCents - p.penaltyCents, { brokerRate: p.brokerRateBp / 10_000, stateRate: p.stateRateBp / 10_000 });
      if (levy <= 0) continue;
      entries.push({ id: entryId, effectiveAt: p.occurredAt, kind: "adjustment", description: "State loan levy", bankTransactionId: p.txId });
      lines.push(
        { entryId, accountCode: "5100", debitCents: levy, creditCents: 0, memo: "State's share of principal" },
        { entryId, accountCode: "1100", debitCents: 0, creditCents: levy, memo: "State's share of principal" },
      );
      levyUpdates.push({ txId: p.txId, levy, entryId });
    }

    await chunked(entries, (c) => tx.insert(journalEntry).values(c));
    await chunked(lines, (c) => tx.insert(journalLine).values(c));
    await chunked(levyUpdates, (c) =>
      tx.execute(sql`update loan_payment_link l set levy_cents = v.levy, levy_entry_id = v.entry::uuid
        from (values ${sql.join(c.map((u) => sql`(${u.txId}::uuid, ${u.levy}::bigint, ${u.entryId})`), sql`, `)}) as v(tx, levy, entry)
        where l.bank_transaction_id = v.tx`),
    );
    await chunked(recoveryUpdates, (c) =>
      tx.execute(sql`update loan_payment_link l set recovery_entry_id = v.entry::uuid
        from (values ${sql.join(c.map((u) => sql`(${u.txId}::uuid, ${u.entryId})`), sql`, `)}) as v(tx, entry)
        where l.bank_transaction_id = v.tx`),
    );
    const levyEntries = levyUpdates.length;
    const recoveryEntries = recoveryUpdates.length;

    // 4b. True up levies posted under an earlier rule (cents before whole-dollar
    // rounding; a levy on early repayments before 2026-10-13). The journal is immutable,
    // so the difference is a new entry.
    const posted = await tx
      .select({
        txId: loanPaymentLink.bankTransactionId,
        role: loanPaymentLink.role,
        levyCents: loanPaymentLink.levyCents,
        penaltyCents: loanPaymentLink.penaltyCents,
        amountCents: bankTransaction.amountCents,
        occurredAt: bankTransaction.occurredAt,
        brokerRateBp: loan.brokerRateBp,
        stateRateBp: loan.stateRateBp,
        status: loan.status,
      })
      .from(loanPaymentLink)
      .innerJoin(bankTransaction, eq(bankTransaction.id, loanPaymentLink.bankTransactionId))
      .innerJoin(loan, eq(loan.id, loanPaymentLink.loanId))
      .where(and(isNotNull(loanPaymentLink.levyEntryId), isNull(loanPaymentLink.recoveryEntryId)));
    const trueUpEntries: (typeof journalEntry.$inferInsert)[] = [];
    const trueUpLines: (typeof journalLine.$inferInsert)[] = [];
    const trueUps: { txId: string; levy: number }[] = [];
    for (const p of posted) {
      if (p.stateRateBp === null || p.brokerRateBp === null) continue;
      const levy = levyFor(p.role as LinkRole, p.amountCents - p.penaltyCents, { brokerRate: p.brokerRateBp / 10_000, stateRate: p.stateRateBp / 10_000 });
      const diff = levy - p.levyCents;
      if (diff === 0) continue;
      const entryId = randomUUID();
      const memo = p.role === "early_principal" ? "No State levy on early repayments: the borrower paid the State's share" : "State levy rounded to whole dollars";
      // A written-off loan's receivable was cleared to credit losses by the write-off, sized from the
      // old levy: the difference belongs there, not back on the receivable.
      const other = p.status === "written_off" ? "5300" : "1100";
      trueUpEntries.push({ id: entryId, effectiveAt: p.occurredAt, kind: "adjustment", description: "State loan levy correction", bankTransactionId: p.txId });
      trueUpLines.push(
        { entryId, accountCode: diff > 0 ? "5100" : other, debitCents: Math.abs(diff), creditCents: 0, memo },
        { entryId, accountCode: diff > 0 ? other : "5100", debitCents: 0, creditCents: Math.abs(diff), memo },
      );
      trueUps.push({ txId: p.txId, levy });
    }
    await chunked(trueUpEntries, (c) => tx.insert(journalEntry).values(c));
    await chunked(trueUpLines, (c) => tx.insert(journalLine).values(c));
    await chunked(trueUps, (c) =>
      tx.execute(sql`update loan_payment_link l set levy_cents = v.levy
        from (values ${sql.join(c.map((u) => sql`(${u.txId}::uuid, ${u.levy}::bigint)`), sql`, `)}) as v(tx, levy)
        where l.bank_transaction_id = v.tx`),
    );

    // 4c. Default dates first estimated from the paste time (old-version cards have no
    // "First missed payment" date) are brought back to when the loan really defaulted.
    const defaulted = await tx.execute<{ id: string; first_default_at: Date; first_missed: string | null; period_days: number | null; opened_at: Date | null; last_paid: Date | null }>(sql`
      select l.id, l.first_default_at, l.period_days, l.opened_at,
        (select c.parsed->>'firstMissedAt' from loan_card c join loan_paste p on p.id = c.paste_id
          where c.loan_id = l.id and c.parsed->>'firstMissedAt' is not null order by p.captured_at desc limit 1) as first_missed,
        (select max(b.occurred_at) from loan_payment_link k join bank_transaction b on b.id = k.bank_transaction_id
          where k.loan_id = l.id and k.role in ('principal','early_principal','late_principal')) as last_paid
      from loan l where l.status = 'defaulted' and l.first_default_at is not null and l.retired_at is null`);
    for (const d of defaulted.rows) {
      const stored = new Date(d.first_default_at);
      const estimate = estimateDefaultedAt({
        firstMissedAt: d.first_missed ? new Date(d.first_missed) : null,
        periodDays: d.period_days,
        lastPaidAt: d.last_paid ? new Date(d.last_paid) : null,
        openedAt: d.opened_at ? new Date(d.opened_at) : null,
        now: stored,
      });
      if (stored.getTime() - estimate.getTime() < 86_400_000) continue; // within a day: leave it
      await tx.update(loan).set({ firstDefaultAt: estimate, updatedAt: new Date() }).where(eq(loan.id, d.id));
      await tx.insert(loanEvent).values({ loanId: d.id, kind: "default_date_corrected", detail: { from: stored.toISOString(), to: estimate.toISOString() } });
    }

    // 4d. Next payment of a running loan from the bank: the game's own due date (`nextPaymentDue`). A paste only
    // estimates it from a countdown, which is late when the text was copied earlier than it was pasted.
    const running = await tx.execute<{ id: string; opened_at: Date; period_days: number | null; instalments: number; last_completed: number | null; next_payment_due_at: Date | null; next_in: { value: number; unit: "minutes" | "hours" | "days" } | null; captured_at: Date | null; paid_at: string[] | null }>(sql`
      select l.id, l.opened_at, l.period_days, l.instalments, l.last_completed, l.next_payment_due_at, c.next_in, c.captured_at,
        (select json_agg(b.occurred_at order by b.occurred_at) from loan_payment_link k join bank_transaction b on b.id = k.bank_transaction_id
          where k.loan_id = l.id and k.role in ('principal', 'late_principal')) as paid_at
      from loan l
      left join lateral (
        select c.parsed->'nextPaymentIn' as next_in, p.captured_at from loan_card c join loan_paste p on p.id = c.paste_id
         where c.loan_id = l.id order by p.captured_at desc, c.id desc limit 1) c on true
      where l.status = 'active' and l.retired_at is null and l.disbursement_tx_id is not null
        and l.opened_at is not null and l.instalments is not null`);
    for (const r of running.rows) {
      const paidAt = (r.paid_at ?? []).map((d) => new Date(d));
      const estimate = r.next_in && r.captured_at ? nextDueFrom({ nextPaymentIn: r.next_in }, new Date(r.captured_at)) : null;
      const next = nextPaymentDue({ openedAt: new Date(r.opened_at), periodDays: r.period_days ?? 7, instalments: r.instalments }, paidAt, { completed: r.last_completed, estimate });
      const stored = r.next_payment_due_at ? new Date(r.next_payment_due_at) : null;
      if ((next?.getTime() ?? null) === (stored?.getTime() ?? null)) continue;
      await tx.update(loan).set({ nextPaymentDueAt: next, updatedAt: new Date() }).where(eq(loan.id, r.id));
    }

    // 5. Close what's left on completed loans (the game says they're done).
    // Each loan's closing difference sits wholly in 5110 (shortfall) or 4310
    // (surplus); later receipts or levy corrections move it there, never split it.
    const residuals = await tx.execute<{ loan_id: string; residual: string; shortfall: string; surplus: string; at: Date }>(sql`
      select l.id as loan_id,
             l.principal_cents - coalesce(r.principal, 0) - coalesce(r.levy, 0)
               - coalesce((select sum(a.amount_cents) from loan_adjustment a where a.loan_id = l.id), 0) as residual,
             coalesce(c.shortfall, 0) as shortfall,
             coalesce(c.surplus, 0) as surplus,
             coalesce(l.completed_at, r.last_at, now()) as at
      from loan l
      left join (
        select k.loan_id,
               sum(case when k.role in ('principal','early_principal','late_principal') then b.amount_cents - k.penalty_cents else 0 end) as principal,
               sum(k.levy_cents) as levy,
               max(b.occurred_at) as last_at
        from loan_payment_link k join bank_transaction b on b.id = k.bank_transaction_id
        group by k.loan_id
      ) r on r.loan_id = l.id
      left join (
        select a.loan_id,
               sum(case when jl.account_code = '5110' then jl.debit_cents - jl.credit_cents else 0 end) as shortfall,
               sum(case when jl.account_code = '4310' then jl.credit_cents - jl.debit_cents else 0 end) as surplus
        from loan_adjustment a join journal_line jl on jl.entry_id = a.journal_entry_id
        group by a.loan_id
      ) c on c.loan_id = l.id
      where l.status = 'completed' and l.disbursement_tx_id is not null`);
    const adjustments: (typeof loanAdjustment.$inferInsert)[] = [];
    const closeEntries: (typeof journalEntry.$inferInsert)[] = [];
    const closeLines: (typeof journalLine.$inferInsert)[] = [];
    for (const r of residuals.rows) {
      const residual = Number(r.residual);
      const shortfall = Number(r.shortfall);
      const surplus = Number(r.surplus);
      const net = shortfall - surplus + residual; // positive = shortfall overall
      const dShortfall = Math.max(net, 0) - shortfall;
      const dSurplus = Math.max(-net, 0) - surplus;
      if (residual === 0 && dShortfall === 0 && dSurplus === 0) continue;
      const entryId = randomUUID();
      const memo = net > 0 ? "Loan closed with principal unpaid" : "Loan closed with principal overpaid";
      const line = (accountCode: string, signedDebit: number) =>
        ({ entryId, accountCode, debitCents: Math.max(signedDebit, 0), creditCents: Math.max(-signedDebit, 0), memo }) as const;
      closeEntries.push({ id: entryId, effectiveAt: new Date(r.at), kind: "adjustment", description: `Loan closing ${net > 0 ? "shortfall" : "surplus"}` });
      if (dShortfall !== 0) closeLines.push(line("5110", dShortfall));
      if (dSurplus !== 0) closeLines.push(line("4310", -dSurplus));
      if (residual !== 0) closeLines.push(line("1100", -residual));
      adjustments.push({ loanId: r.loan_id, journalEntryId: entryId, kind: "closing", amountCents: residual });
    }
    await chunked(closeEntries, (c) => tx.insert(journalEntry).values(c));
    await chunked(closeLines, (c) => tx.insert(journalLine).values(c));
    await chunked(adjustments, (c) => tx.insert(loanAdjustment).values(c));

    // 6. Issued loan offers meet the loan the game paid out: same borrower, same amount,
    //    paid out from the day before the contract date to three weeks after (ORIGINATION.md).
    //    Never a loan someone unlinked from that offer by hand.
    const openOffers = await tx.execute<{ id: string; sid: number; amount: string; starts: Date; excluded: string[] }>(sql`
      select id, borrower_state_id as sid, amount_cents as amount, starts_on as starts, to_json(excluded_loan_ids) as excluded
        from loan_offer where status = 'issued' and loan_id is null order by starts_on`);
    if (openOffers.rows.length) {
      const taken = new Set((await tx.execute<{ id: string }>(sql`select loan_id as id from loan_offer where loan_id is not null`)).rows.map((r) => r.id));
      for (const o of openOffers.rows) {
        const starts = new Date(o.starts);
        const [hit] = (
          await tx.execute<{ id: string; opened: Date }>(sql`
            select id, opened_at as opened from loan where retired_at is null and borrower_state_id = ${o.sid} and principal_cents = ${Number(o.amount)}
               and opened_at between ${new Date(starts.getTime() - 86_400_000)} and ${new Date(starts.getTime() + 21 * 86_400_000)} order by opened_at`)
        ).rows.filter((l) => !taken.has(l.id) && !o.excluded.includes(l.id));
        if (!hit) continue;
        taken.add(hit.id);
        await tx.execute(sql`update loan_offer set status = 'funded', loan_id = ${hit.id}, funded_at = ${new Date(hit.opened)}, updated_at = now() where id = ${o.id}`);
      }
    }

    // 7. Attorney & filing fee payments that name their legal case (#LC12).
    await syncLegalFees(tx);

    return {
      loansCreated: toCreate.length,
      linksCreated: newLinks.length + recoveryLinks.length + refundLinks.length,
      levyEntries,
      levyCorrections: trueUps.length,
      penaltyEntries: penaltyEntries.length,
      recoveryEntries,
      closingEntries: adjustments.length,
    };
  };

  return executor ? run(executor) : db.transaction(run);
}

/** Principal still owed per loan: principal − principal received − State levy − closing adjustments. */
export async function outstandingByLoan(
  executor: typeof db | Tx = db,
  loanIds?: string[],
): Promise<Map<string, { returnedCents: number; levyCents: number; adjustedCents: number }>> {
  const rows = await executor
    .select({
      loanId: loanPaymentLink.loanId,
      returned: sql<string>`coalesce(sum(case when ${loanPaymentLink.role} in ('principal','early_principal','late_principal') then ${bankTransaction.amountCents} - ${loanPaymentLink.penaltyCents} else 0 end), 0)`,
      levy: sql<string>`coalesce(sum(${loanPaymentLink.levyCents}), 0)`,
    })
    .from(loanPaymentLink)
    .innerJoin(bankTransaction, eq(bankTransaction.id, loanPaymentLink.bankTransactionId))
    .where(loanIds ? inArray(loanPaymentLink.loanId, loanIds) : undefined)
    .groupBy(loanPaymentLink.loanId);
  const adjusted = await executor
    .select({ loanId: loanAdjustment.loanId, cents: sql<string>`sum(${loanAdjustment.amountCents})` })
    .from(loanAdjustment)
    .where(loanIds ? inArray(loanAdjustment.loanId, loanIds) : undefined)
    .groupBy(loanAdjustment.loanId);
  const adjustedBy = new Map(adjusted.map((a) => [a.loanId, Number(a.cents)]));
  return new Map(rows.map((r) => [r.loanId, { returnedCents: Number(r.returned), levyCents: Number(r.levy), adjustedCents: adjustedBy.get(r.loanId) ?? 0 }]));
}
