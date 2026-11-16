import "server-only";
import { matchQuotes } from "@/server/origination/mortgage-quotes";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { mortgageAddress } from "@/domain/bank/classify";
import { hasAddress, movedTo, originationFits, originationPattern, repaymentMortgage, withAlias, type OriginationAmounts, type RepaymentCandidate, type RepaymentRow } from "@/domain/mortgages/identity";
import { mortgageSchedule } from "@/domain/mortgages/schedule";
import { db, type Tx } from "@/server/db";
import { bankTransaction, journalEntry, journalLine, mortgage, mortgageEvent, mortgagePayment, mortgageSettlement, mortgageSnapshot } from "@/server/db/schema";

/**
 * Keeps mortgages consistent with the bank rows (docs/design/MORTGAGES.md).
 * Idempotent: runs after every bank import and tablet paste.
 */

/** Held by every mortgage sync (and while closing a commission week). */
export const MORTGAGE_SYNC_LOCK = 0x4c4c4d47; // "LLMG"
const SYNC_LOCK = MORTGAGE_SYNC_LOCK;

export type MortgageSyncSummary = {
  created: number;
  adopted: number;
  merged: number;
  paymentsLinked: number;
  /** Company-funded: origination receivables and repayment splits posted. */
  fundingEntries: number;
  repaymentEntries: number;
  completed: number;
  unlinkedPayments: number;
};

type Row = typeof mortgage.$inferSelect;

const outTx = alias(bankTransaction, "out_tx");

type RepaymentBankRow = { id: string; comment: string; occurredAt: Date; initiatorStateId: number | null; amountCents: number };
type Candidate = RepaymentCandidate & { row: Row; lastSeenAt: Date };

const repaymentRow = (r: RepaymentBankRow, address: string | null): RepaymentRow => ({ address, payerStateId: r.initiatorStateId, occurredAt: r.occurredAt, grossCents: r.amountCents });

/** What `repaymentMortgage` needs of each live mortgage, and which repayment rows are linked already. */
async function repaymentCandidates(executor: typeof db | Tx, mortgages: Row[]) {
  const paid = await executor
    .select({ txId: mortgagePayment.bankTransactionId, mortgageId: mortgagePayment.mortgageId, at: bankTransaction.occurredAt, gross: bankTransaction.amountCents })
    .from(mortgagePayment)
    .innerJoin(bankTransaction, eq(bankTransaction.id, mortgagePayment.bankTransactionId));
  const linked = new Set(paid.map((p) => p.txId));
  const byMortgage = Map.groupBy(paid, (p) => p.mortgageId);
  const candidates: Candidate[] = mortgages.map((m) => {
    const own = byMortgage.get(m.id) ?? [];
    // When the mortgage's address was last known: a later repayment under another address means it moved.
    const seen = [m.originatedAt, m.lastTabletAt, ...own.map((p) => p.at)].filter((d): d is Date => d !== null);
    return {
      row: m,
      address: m.address,
      addressAliases: m.addressAliases,
      buyerStateId: m.buyerStateId,
      originatedAt: m.originatedAt,
      status: m.status,
      paidGrossCents: own.map((p) => p.gross),
      lastSeenAt: new Date(Math.max(0, ...seen.map((d) => d.getTime()))),
    };
  });
  return { linked, candidates };
}

/** Money of each origination row: net received and (once paired) the transfer to the State. */
export async function originationAmounts(executor: typeof db | Tx, txIds: string[]): Promise<Map<string, OriginationAmounts>> {
  if (txIds.length === 0) return new Map();
  const rows = await executor
    .select({ id: bankTransaction.id, amount: bankTransaction.amountCents, tax: bankTransaction.taxCents, out: outTx.amountCents })
    .from(bankTransaction)
    .leftJoin(mortgageSettlement, and(eq(mortgageSettlement.inTxId, bankTransaction.id), isNull(mortgageSettlement.unwoundAt)))
    .leftJoin(outTx, eq(outTx.id, mortgageSettlement.outTxId))
    .where(inArray(bankTransaction.id, txIds));
  return new Map(rows.map((r) => [r.id, { netInCents: r.amount - r.tax, outCents: r.out ?? null }]));
}

export async function syncMortgages(executor?: Tx): Promise<MortgageSyncSummary> {
  const run = async (tx: Tx): Promise<MortgageSyncSummary> => {
    await tx.execute(sql`select pg_advisory_xact_lock(${SYNC_LOCK})`);

    const rows = await tx
      .select({
        id: bankTransaction.id,
        category: bankTransaction.category,
        comment: bankTransaction.comment,
        occurredAt: bankTransaction.occurredAt,
        initiatorStateId: bankTransaction.initiatorStateId,
        initiatorName: bankTransaction.initiatorName,
        amountCents: bankTransaction.amountCents,
      })
      .from(bankTransaction)
      .where(inArray(bankTransaction.category, ["mortgage.origination_in", "mortgage.repayment_in"]))
      .orderBy(bankTransaction.occurredAt);
    const existing: Row[] = await tx.select().from(mortgage).where(isNull(mortgage.mergedIntoId));
    const byOrigination = new Map(existing.filter((m) => m.originationTxId).map((m) => [m.originationTxId!, m]));
    let created = 0;
    let adopted = 0;
    let merged = 0;

    // 1. A mortgage for every "Down Payment & Fees" row.
    for (const r of rows.filter((x) => x.category === "mortgage.origination_in")) {
      if (byOrigination.has(r.id)) continue;
      const address = mortgageAddress(r.comment);
      if (!address) continue;
      // Another buyer's record on that address is a different house that once had its number.
      const otherBuyer = (m: Row) => m.buyerStateId !== null && r.initiatorStateId !== null && m.buyerStateId !== r.initiatorStateId;
      const tabletOnly = existing.find((m) => !m.originationTxId && hasAddress(m, address) && !otherBuyer(m));
      if (tabletOnly) {
        // Pasted from the tablet before the bank export arrived.
        tabletOnly.originationTxId = r.id;
        tabletOnly.originatedAt = r.occurredAt;
        await tx
          .update(mortgage)
          .set({ originationTxId: r.id, originatedAt: r.occurredAt, buyerStateId: tabletOnly.buyerStateId ?? r.initiatorStateId, updatedAt: new Date() })
          .where(eq(mortgage.id, tabletOnly.id));
        await tx.insert(mortgageEvent).values({ mortgageId: tabletOnly.id, at: r.occurredAt, kind: "origination_linked", detail: {} });
        byOrigination.set(r.id, tabletOnly);
        adopted++;
        continue;
      }
      const id = randomUUID();
      await tx.insert(mortgage).values({ id, address, originationTxId: r.id, originatedAt: r.occurredAt, buyerStateId: r.initiatorStateId, buyerName: r.initiatorName });
      await tx.insert(mortgageEvent).values({ mortgageId: id, at: r.occurredAt, kind: "originated", detail: {} });
      const full = (await tx.select().from(mortgage).where(eq(mortgage.id, id)))[0];
      existing.push(full);
      byOrigination.set(r.id, full);
      created++;
    }

    // 2. Merge duplicates caused by a renumbered address: a tablet-only mortgage and an
    // unpasted bank mortgage of the same buyer whose money matches exactly (one each).
    const tabletOnly = existing.filter((m) => !m.originationTxId && m.lastTabletAt);
    const unpasted = existing.filter((m) => m.originationTxId && !m.lastTabletAt);
    const amounts = await originationAmounts(tx, unpasted.map((m) => m.originationTxId!));
    for (const t of tabletOnly) {
      const fits = unpasted.filter((b) => b.buyerStateId !== null && b.buyerStateId === t.buyerStateId && amounts.has(b.originationTxId!) && originationFits(t, amounts.get(b.originationTxId!)!));
      if (fits.length !== 1) continue;
      const b = fits[0];
      const claimants = tabletOnly.filter((o) => !o.originationTxId && o.buyerStateId === b.buyerStateId && originationFits(o, amounts.get(b.originationTxId!)!));
      if (claimants.length !== 1) continue; // ambiguous — leave for a person
      const now = new Date();
      // Keep the pasted record (it has the terms, officer and history); retire the bank-only one.
      await tx.update(mortgage).set({ originationTxId: null, mergedIntoId: t.id, updatedAt: now }).where(eq(mortgage.id, b.id));
      await tx
        .update(mortgage)
        .set({
          originationTxId: b.originationTxId,
          originatedAt: b.originatedAt,
          buyerName: t.buyerName ?? b.buyerName,
          officerStaffId: t.officerStaffId ?? b.officerStaffId,
          addressAliases: withAlias(t.addressAliases, t.address, b.address),
          updatedAt: now,
        })
        .where(eq(mortgage.id, t.id));
      await tx.update(mortgagePayment).set({ mortgageId: t.id }).where(eq(mortgagePayment.mortgageId, b.id));
      await tx.update(mortgageSnapshot).set({ mortgageId: t.id }).where(eq(mortgageSnapshot.mortgageId, b.id));
      await tx.insert(mortgageEvent).values([
        { mortgageId: t.id, at: now, kind: "merged", detail: { fromAddress: b.address, mergedId: b.id } },
        { mortgageId: b.id, at: now, kind: "merged_into", detail: { intoAddress: t.address, intoId: t.id } },
      ]);
      Object.assign(t, { originationTxId: b.originationTxId, originatedAt: b.originatedAt, addressAliases: withAlias(t.addressAliases, t.address, b.address) });
      existing.splice(existing.indexOf(b), 1);
      unpasted.splice(unpasted.indexOf(b), 1);
      merged++;
    }

    // 3. Link repayments by who paid, the address telling a buyer's mortgages apart (`repaymentMortgage`). A buyer's
    // repayment under an address the mortgage doesn't have means the server renumbered the house: the newest one wins.
    const repayments = rows.filter((x) => x.category === "mortgage.repayment_in");
    const { linked, candidates } = await repaymentCandidates(tx, existing);
    const links: (typeof mortgagePayment.$inferInsert)[] = [];
    let unlinked = 0;
    for (const r of repayments) {
      if (linked.has(r.id)) continue;
      const address = mortgageAddress(r.comment);
      const found = repaymentMortgage(repaymentRow(r, address), candidates);
      if (!found) {
        unlinked++;
        continue;
      }
      const c = found.mortgage;
      links.push({ bankTransactionId: r.id, mortgageId: c.row.id });
      c.paidGrossCents.push(r.amountCents);
      const newest = r.occurredAt >= c.lastSeenAt;
      c.lastSeenAt = newest ? r.occurredAt : c.lastSeenAt;
      const moved = address && newest && c.buyerStateId === r.initiatorStateId ? movedTo(c, address) : null;
      if (moved) {
        await tx.update(mortgage).set({ ...moved, updatedAt: new Date() }).where(eq(mortgage.id, c.row.id));
        await tx.insert(mortgageEvent).values({ mortgageId: c.row.id, at: r.occurredAt, kind: "address_changed", detail: { from: c.address, to: moved.address, source: "bank" } });
        Object.assign(c, moved);
        Object.assign(c.row, moved);
      }
    }
    for (let i = 0; i < links.length; i += 500) await tx.insert(mortgagePayment).values(links.slice(i, i + 500));

    // 4. Company-funded mortgages (Litt's lent its own money). The bank pairing booked the
    // origination residual (banker fee − loan) to 4100; move the loan part to a receivable.
    const company = existing.filter((m) => m.funding === "company" && m.originationTxId && m.loanCents !== null);
    const companyAmounts = await originationAmounts(tx, company.map((m) => m.originationTxId!));
    const settledOrigins = new Set(
      company.length
        ? (
            await tx
              .select({ inTxId: mortgageSettlement.inTxId })
              .from(mortgageSettlement)
              .where(and(inArray(mortgageSettlement.inTxId, company.map((m) => m.originationTxId!)), isNull(mortgageSettlement.unwoundAt)))
          ).map((s) => s.inTxId)
        : [],
    );
    let fundingEntries = 0;
    for (const m of company) {
      if (m.fundingEntryId || !settledOrigins.has(m.originationTxId!)) continue;
      const o = companyAmounts.get(m.originationTxId!);
      if (!o || originationPattern(m, o) !== "company") continue; // money doesn't confirm it — leave for a person
      const entryId = randomUUID();
      const memo = `Loan from company funds — ${m.address}`;
      await tx.insert(journalEntry).values({ id: entryId, effectiveAt: m.originatedAt!, kind: "adjustment", description: memo, bankTransactionId: m.originationTxId });
      await tx.insert(journalLine).values([
        { entryId, accountCode: "1120", debitCents: m.loanCents!, creditCents: 0, memo },
        { entryId, accountCode: "4100", debitCents: 0, creditCents: m.loanCents!, memo },
      ]);
      await tx.update(mortgage).set({ fundingEntryId: entryId, updatedAt: new Date() }).where(eq(mortgage.id, m.id));
      await tx.insert(mortgageEvent).values({ mortgageId: m.id, kind: "company_funded_booked", detail: { loanCents: m.loanCents } });
      fundingEntries++;
    }

    // 5. Their repayments stay with Litt's (nothing goes to the State): split each into
    // principal (back off the receivable) and broker interest, by the schedule.
    let repaymentEntries = 0;
    if (company.length) {
      const pays = await tx
        .select({
          txId: bankTransaction.id,
          mortgageId: mortgagePayment.mortgageId,
          entryId: mortgagePayment.entryId,
          occurredAt: bankTransaction.occurredAt,
          net: sql<number>`${bankTransaction.amountCents} - ${bankTransaction.taxCents}`.mapWith(Number),
          paired: sql<boolean>`exists (select 1 from mortgage_settlement s where s.in_tx_id = ${bankTransaction.id} and s.unwound_at is null)`,
        })
        .from(mortgagePayment)
        .innerJoin(bankTransaction, eq(bankTransaction.id, mortgagePayment.bankTransactionId))
        .where(inArray(mortgagePayment.mortgageId, company.map((m) => m.id)))
        .orderBy(bankTransaction.occurredAt);
      for (const m of company) {
        if (!m.instalments || m.brokerInterestCents === null || !m.originatedAt) continue;
        const schedule = mortgageSchedule({ loanCents: m.loanCents!, brokerInterestCents: m.brokerInterestCents, federalInterestCents: 0, instalments: m.instalments, originatedAt: m.originatedAt });
        const mine = pays.filter((p) => p.mortgageId === m.id);
        for (const [i, p] of mine.entries()) {
          if (p.entryId || p.paired) continue;
          const principal = Math.min(schedule[i]?.principalCents ?? 0, p.net);
          const interest = p.net - principal;
          const entryId = randomUUID();
          const memo = `Repayment to Litt's — ${m.address}`;
          await tx.insert(journalEntry).values({ id: entryId, effectiveAt: p.occurredAt, kind: "adjustment", description: memo, bankTransactionId: p.txId });
          await tx.insert(journalLine).values([
            { entryId, accountCode: "1110", debitCents: p.net, creditCents: 0, memo },
            ...(principal > 0 ? [{ entryId, accountCode: "1120", debitCents: 0, creditCents: principal, memo: `Principal — ${m.address}` }] : []),
            ...(interest > 0 ? [{ entryId, accountCode: "4110", debitCents: 0, creditCents: interest, memo: `Broker interest — ${m.address}` }] : []),
          ]);
          await tx.update(mortgagePayment).set({ entryId }).where(eq(mortgagePayment.bankTransactionId, p.txId));
          repaymentEntries++;
        }
      }
    }

    // 6. All instalments paid → completed.
    const done = await tx.execute<{ id: string }>(sql`
      select m.id from mortgage m
      where m.status = 'active' and m.merged_into_id is null and m.instalments is not null
        and (select count(*) from mortgage_payment p where p.mortgage_id = m.id) >= m.instalments`);
    const doneIds = done.rows.map((d) => d.id);
    if (doneIds.length) {
      await tx.update(mortgage).set({ status: "completed", updatedAt: new Date() }).where(and(inArray(mortgage.id, doneIds), eq(mortgage.status, "active")));
      await tx.insert(mortgageEvent).values(doneIds.map((id) => ({ mortgageId: id, kind: "completed", detail: {} })));
    }

    // Quotes made in the app meet the mortgages they became (ORIGINATION.md).
    await matchQuotes(tx);

    return { created, adopted, merged, paymentsLinked: links.length, fundingEntries, repaymentEntries, completed: doneIds.length, unlinkedPayments: unlinked };
  };
  return executor ? run(executor) : db.transaction(run);
}

/**
 * Read-only: is anything not reflected yet — an origination with no mortgage, a repayment
 * that could be linked, a likely duplicate to merge? Every write that can cause this runs
 * `syncMortgages` itself (import, tablet paste, reclassify); pages no longer sync on load
 * (owner review, 2026-10-11). Tests assert this stays false after those writes.
 */
export async function mortgageSyncPending(executor: typeof db | Tx = db): Promise<boolean> {
  const { rows } = await executor.execute<{ pending: boolean }>(sql`
    select exists (
      select 1 from bank_transaction b
      where b.category = 'mortgage.origination_in'
        and not exists (select 1 from mortgage m where m.origination_tx_id = b.id)
    ) or exists (
      select 1 from mortgage t join mortgage b on b.buyer_state_id = t.buyer_state_id
      where t.origination_tx_id is null and t.last_tablet_at is not null and t.merged_into_id is null
        and b.origination_tx_id is not null and b.last_tablet_at is null and b.merged_into_id is null
    ) or exists (
      select 1 from mortgage m
      where m.funding = 'company' and m.merged_into_id is null and m.origination_tx_id is not null
        and (m.funding_entry_id is null
             or exists (select 1 from mortgage_payment p where p.mortgage_id = m.id and p.entry_id is null))
    ) as pending`);
  return Boolean(rows[0]?.pending) || (await repaymentLinkable(executor));
}

/** An unlinked repayment the sync would link now (the same rule, so the two can't disagree). */
async function repaymentLinkable(executor: typeof db | Tx): Promise<boolean> {
  const unlinked = await executor
    .select({ id: bankTransaction.id, comment: bankTransaction.comment, occurredAt: bankTransaction.occurredAt, initiatorStateId: bankTransaction.initiatorStateId, amountCents: bankTransaction.amountCents })
    .from(bankTransaction)
    .leftJoin(mortgagePayment, eq(mortgagePayment.bankTransactionId, bankTransaction.id))
    .where(and(eq(bankTransaction.category, "mortgage.repayment_in"), isNull(mortgagePayment.bankTransactionId)));
  if (unlinked.length === 0) return false;
  const live: Row[] = await executor.select().from(mortgage).where(isNull(mortgage.mergedIntoId));
  const { candidates } = await repaymentCandidates(executor, live);
  return unlinked.some((r) => repaymentMortgage(repaymentRow(r, mortgageAddress(r.comment)), candidates) !== null);
}
