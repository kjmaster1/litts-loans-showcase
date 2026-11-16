import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, gte, inArray, isNull, lt, max, sql } from "drizzle-orm";
import { z } from "zod";
import { calculateWeek, DEFAULT_RATES, type BankerFee, type CommissionRates, type InterestReceipt, type WeekCalculation } from "@/domain/commissions/calculate";
import { alreadyPaid, parseCommissionItems, type PaidItem } from "@/domain/commissions/legacy";
import { CATCH_UP_KEY, COMMISSION_START, dayMonth, isPeriodKey, periodLabel, periodRange, weekKeyOf } from "@/domain/commissions/week";
import { zonedParts } from "@/lib/company-time";
import { wholeDollars } from "@/lib/money";
import { can, ForbiddenError } from "@/lib/permissions";
import { recordAudit } from "@/server/audit/audit";
import type { Viewer } from "@/server/authz/viewer";
import { db, type Tx } from "@/server/db";
import {
  bankTransaction,
  commissionAward,
  commissionLine,
  commissionPayout,
  commissionRoster,
  commissionWeek,
  journalEntry,
  journalLine,
  loan,
  loanPaymentLink,
  mortgage,
  staff,
} from "@/server/db/schema";
import { LoanError } from "@/server/loans/errors";
import { LOAN_SYNC_LOCK } from "@/server/loans/sync";
import { MORTGAGE_SYNC_LOCK, originationAmounts } from "@/server/mortgages/sync";
import { getRequestMeta } from "@/server/request";
import { WORKING_STATUSES, isWorkingStatus } from "@/lib/roles";
import { commissionRates } from "@/domain/settings";
import { getSettings } from "@/server/settings";

/** Commissions (docs/design/COMMISSIONS.md). */

type Executor = typeof db | Tx;
const INTEREST_ROLES = ["interest", "early_interest", "late_fee"];

function assertWeek(key: string) {
  if (!isPeriodKey(key)) throw new LoanError("That isn't a commission week.");
}

const DAY_MS = 86_400_000;

/** Interest receipts linked to loans in [from, to), oldest first. */
export async function interestReceipts(executor: Executor, from: Date, to: Date) {
  return executor
    .select({
      txId: bankTransaction.id,
      at: bankTransaction.occurredAt,
      amount: bankTransaction.amountCents,
      tax: bankTransaction.taxCents,
      role: loanPaymentLink.role,
      loanId: loan.id,
      loanStatus: loan.status,
      officerStaffId: loan.officerStaffId,
      borrower: loan.borrowerName,
      stateId: loan.borrowerStateId,
    })
    .from(loanPaymentLink)
    .innerJoin(bankTransaction, eq(bankTransaction.id, loanPaymentLink.bankTransactionId))
    .innerJoin(loan, eq(loan.id, loanPaymentLink.loanId))
    .where(and(inArray(loanPaymentLink.role, INTEREST_ROLES), gte(bankTransaction.occurredAt, from), lt(bankTransaction.occurredAt, to)))
    .orderBy(bankTransaction.occurredAt);
}

export type OldItem = PaidItem & { payoutTxId: string; paidAt: Date; wallet: string | null };

/** What the hand-paid commission runs before the scheme said they paid for (research/10). */
export async function oldCommissionItems(executor: Executor): Promise<OldItem[]> {
  const rows = await executor
    .select({ id: bankTransaction.id, at: bankTransaction.occurredAt, comment: bankTransaction.comment, wallet: bankTransaction.targetWallet })
    .from(bankTransaction)
    .where(and(eq(bankTransaction.category, "commission"), lt(bankTransaction.occurredAt, COMMISSION_START), sql`${bankTransaction.comment} ilike '%Commission Pay%'`))
    .orderBy(bankTransaction.occurredAt);
  return rows.flatMap((r) => parseCommissionItems(r.comment ?? "").map((i) => ({ ...i, payoutTxId: r.id, paidAt: r.at, wallet: r.wallet })));
}

export type Receipt = Awaited<ReturnType<typeof interestReceipts>>[number];

/** Receipt id → the old payment item that covered it. */
export function matchOldItems(receipts: Receipt[], items: OldItem[]): Map<string, OldItem> {
  return alreadyPaid(
    receipts.map((r) => {
      const d = zonedParts(r.at);
      return {
        id: r.txId,
        borrowerName: r.borrower,
        year: d.year,
        month: d.month,
        day: d.day,
        kind: r.role === "early_interest" ? ("early_interest" as const) : ("interest" as const),
        // The old hand-paid scheme paid 50%: compare at that rate whatever the setting is now.
        commissionCents: wholeDollars((r.amount - r.tax) * DEFAULT_RATES.loanInterest),
      };
    }),
    items,
  );
}

export type PaidBefore = { txId: string; at: Date; loanId: string; label: string; netCents: number; paidAt: Date; paidCents: number };

/**
 * The period's interest receipts (net of tax) and banker fees, with their officers
 * as they are now. The catch-up period has no banker fees (they were paid under
 * the old scheme) and leaves out receipts an old payment already covered.
 *
 * A weekly period also carries what arrived late (review 2026-10-13): receipts and banker fees
 * dated in a week that was already closed when they were imported or linked. Closed weeks never
 * change, so without this they'd never be paid. "Paid" is a commission line naming the receipt
 * (or the mortgage's originator line), so once one week closes with it, no other week shows it.
 */
export async function weekInputs(executor: Executor, key: string): Promise<{ interest: InterestReceipt[]; fees: BankerFee[]; paidBefore: PaidBefore[] }> {
  const { from, to } = periodRange(key);
  const catchUp = key === CATCH_UP_KEY;
  // A week of margin so an old item is matched to its own receipt, not a neighbour's.
  const all = await interestReceipts(executor, catchUp ? new Date(from.getTime() - 7 * DAY_MS) : from, to);
  const covered = catchUp ? matchOldItems(all, await oldCommissionItems(executor)) : new Map<string, OldItem>();
  const receipts = all.filter((r) => r.at >= from);
  const label = (r: Receipt) => `Interest — ${r.borrower ?? `State ID ${r.stateId}`}${catchUp ? ` · ${dayMonth(r.at)}` : ""}`;
  const paidBefore = receipts.flatMap((r) => {
    const item = covered.get(r.txId);
    return item ? [{ txId: r.txId, at: r.at, loanId: r.loanId, label: label(r), netCents: r.amount - r.tax, paidAt: item.paidAt, paidCents: item.amountCents }] : [];
  });
  const toInterest = (r: Receipt, text: string): InterestReceipt => ({ txId: r.txId, at: r.at, netCents: r.amount - r.tax, loanId: r.loanId, officerStaffId: r.officerStaffId, label: text });
  const interest = receipts.filter((r) => !covered.has(r.txId)).map((r) => toInterest(r, label(r)));
  if (catchUp) return { interest, fees: [], paidBefore };

  const late = await lateArrivals(executor, from);
  interest.push(...late.interest.map((r) => toInterest(r, `${label(r)} · ${dayMonth(r.at)}, arrived after its week closed`)));

  const started = await executor
    .select()
    .from(mortgage)
    .where(and(isNull(mortgage.mergedIntoId), gte(mortgage.originatedAt, from), lt(mortgage.originatedAt, to)));
  const lateFees = late.mortgages;
  const amounts = await originationAmounts(executor, [...started, ...lateFees].flatMap((m) => (m.originationTxId ? [m.originationTxId] : [])));
  const toFee = (m: typeof mortgage.$inferSelect, text: string): BankerFee => {
    const o = m.originationTxId ? amounts.get(m.originationTxId) : undefined;
    // The tablet's fee; failing that, what a State-funded origination left with Litt's.
    const fromBank = o && o.outCents !== null && m.funding === "state" && o.netInCents - o.outCents > 0 ? o.netInCents - o.outCents : null;
    return { mortgageId: m.id, at: m.originatedAt!, feeCents: m.brokerFeeCents ?? fromBank, originatorStaffId: m.officerStaffId, label: text };
  };

  return {
    interest,
    paidBefore,
    fees: [
      ...started.map((m) => toFee(m, `Banker fee — ${m.address}`)),
      ...lateFees.map((m) => toFee(m, `Banker fee — ${m.address} · ${dayMonth(m.originatedAt!)}, arrived after its week closed`)),
    ],
  };
}

/** Receipts and mortgages dated in closed weeks before `before` that no commission line has paid. */
async function lateArrivals(executor: Executor, before: Date): Promise<{ interest: Receipt[]; mortgages: (typeof mortgage.$inferSelect)[] }> {
  if (before <= COMMISSION_START) return { interest: [], mortgages: [] };
  const closed = new Set(
    (await executor.select({ key: commissionWeek.weekKey }).from(commissionWeek).where(eq(commissionWeek.status, "closed"))).map((w) => w.key),
  );
  if (closed.size === 0) return { interest: [], mortgages: [] };
  const inClosedWeek = (at: Date) => closed.has(weekKeyOf(at));

  const earlier = (await interestReceipts(executor, COMMISSION_START, before)).filter((r) => inClosedWeek(r.at));
  const paidTx = earlier.length
    ? new Set(
        (await executor.select({ id: commissionLine.sourceTxId }).from(commissionLine).where(inArray(commissionLine.sourceTxId, earlier.map((r) => r.txId)))).map(
          (l) => l.id,
        ),
      )
    : new Set<string | null>();

  const older = (
    await executor
      .select()
      .from(mortgage)
      .where(and(isNull(mortgage.mergedIntoId), gte(mortgage.originatedAt, COMMISSION_START), lt(mortgage.originatedAt, before)))
  ).filter((m) => inClosedWeek(m.originatedAt!));
  const paidMortgages = older.length
    ? new Set(
        (
          await executor
            .select({ id: commissionLine.mortgageId })
            .from(commissionLine)
            .where(and(eq(commissionLine.kind, "mortgage_originator"), inArray(commissionLine.mortgageId, older.map((m) => m.id))))
        ).map((l) => l.id),
      )
    : new Set<string | null>();

  return { interest: earlier.filter((r) => !paidTx.has(r.txId)), mortgages: older.filter((m) => !paidMortgages.has(m.id)) };
}

/** The newest bank row in the books: a week can only be closed once the bank export reaches past its end. */
async function bankThrough(executor: Executor): Promise<Date | null> {
  const [row] = await executor.select({ at: max(bankTransaction.occurredAt) }).from(bankTransaction);
  return row?.at ?? null;
}

export type Evidence = { appActions: number; loansArranged: number; loansServiced: number; mortgagesArranged: number; bankRows: number };

/** Activity per working staff member (active or invited) in the week — the basis of the suggested pool roster. */
export async function weekEvidence(executor: Executor, key: string): Promise<Map<string, Evidence>> {
  if (key === CATCH_UP_KEY) return new Map(); // no pool
  const { from, to } = periodRange(key);
  const rows = await executor.execute<{ id: string; app: number; loans: number; serviced: number; mortgages: number; bank: number }>(sql`
    select s.id,
      (select count(*) from audit_event a where a.actor_staff_id = s.id and a.occurred_at >= ${from} and a.occurred_at < ${to})::int as app,
      (select count(*) from loan l where l.officer_staff_id = s.id and l.opened_at >= ${from} and l.opened_at < ${to})::int as loans,
      (select count(distinct k.loan_id) from loan_payment_link k join loan l on l.id = k.loan_id join bank_transaction b on b.id = k.bank_transaction_id
        where l.officer_staff_id = s.id and k.role <> 'disbursement' and b.occurred_at >= ${from} and b.occurred_at < ${to})::int as serviced,
      (select count(*) from mortgage m where m.officer_staff_id = s.id and m.merged_into_id is null and m.originated_at >= ${from} and m.originated_at < ${to})::int as mortgages,
      (select count(*) from bank_transaction b where b.initiator_state_id = s.state_id and b.occurred_at >= ${from} and b.occurred_at < ${to})::int as bank
    from staff s where s.status in ('active', 'invited')`);
  return new Map(
    rows.rows.map((r) => [
      r.id,
      { appActions: Number(r.app), loansArranged: Number(r.loans), loansServiced: Number(r.serviced), mortgagesArranged: Number(r.mortgages), bankRows: Number(r.bank) },
    ]),
  );
}

const evidenceTotal = (e: Evidence) => e.appActions + e.loansArranged + e.loansServiced + e.mortgagesArranged + e.bankRows;
const NO_EVIDENCE: Evidence = { appActions: 0, loansArranged: 0, loansServiced: 0, mortgagesArranged: 0, bankRows: 0 };

export type RosterEntry = { staffId: string; name: string; role: string; included: boolean; suggested: boolean; evidence: Evidence };

export type WeekView = {
  key: string;
  catchUp: boolean;
  /** The rates this week is (or was) calculated with. */
  rates: CommissionRates;
  label: string;
  from: Date;
  to: Date;
  ended: boolean;
  /** The newest bank row in the books, and whether it's past the period's end (needed to close it). */
  bankThrough: Date | null;
  bankCovers: boolean;
  status: "open" | "closed";
  rosterLocked: boolean;
  roster: RosterEntry[];
  calculation: WeekCalculation;
  names: Record<string, string>;
  /** Frozen figures for a closed week. */
  awards: { staffId: string; amountCents: number }[] | null;
  /** Catch-up only, while open: receipts an old payment already covered. */
  paidBefore: PaidBefore[];
};

export async function getWeek(key: string, now: Date = new Date(), executor: Executor = db): Promise<WeekView> {
  assertWeek(key);
  const { from, to } = periodRange(key);
  const catchUp = key === CATCH_UP_KEY;
  const [week] = await executor.select().from(commissionWeek).where(eq(commissionWeek.weekKey, key));
  const people = await executor.select({ id: staff.id, name: staff.characterName, role: staff.role, status: staff.status }).from(staff);
  const names = Object.fromEntries(people.map((p) => [p.id, p.name]));

  if (week?.status === "closed") {
    // One after another: `executor` may be a transaction, whose single connection can't run queries side by side.
    const lines = await executor.select().from(commissionLine).where(eq(commissionLine.weekId, week.id));
    const awards = await executor.select().from(commissionAward).where(eq(commissionAward.weekId, week.id));
    const roster = await executor.select().from(commissionRoster).where(eq(commissionRoster.weekId, week.id));
    const summary = (week.summary ?? {}) as { pool?: WeekCalculation["pool"]; companyShareCents?: number; rates?: CommissionRates };
    return {
      key,
      catchUp,
      rates: summary.rates ?? DEFAULT_RATES,
      label: periodLabel(key),
      from,
      to,
      ended: true,
      bankThrough: null,
      bankCovers: true,
      status: "closed",
      rosterLocked: true,
      roster: roster.map((r) => ({
        staffId: r.staffId,
        name: names[r.staffId] ?? "Former staff",
        role: people.find((p) => p.id === r.staffId)?.role ?? "",
        included: r.included,
        suggested: r.suggested,
        evidence: r.evidence as Evidence,
      })),
      calculation: {
        lines: lines.map((l) => ({ kind: l.kind as never, staffId: l.staffId, label: l.label, baseCents: l.baseCents, amountCents: l.amountCents, sourceTxId: l.sourceTxId ?? undefined })),
        totals: new Map(awards.map((a) => [a.staffId, a.amountCents])),
        pool: summary.pool ?? { totalCents: 0, members: 0, perPersonCents: 0, remainderCents: 0 },
        problems: [],
        companyShareCents: summary.companyShareCents ?? 0,
      },
      names,
      awards: awards.map((a) => ({ staffId: a.staffId, amountCents: a.amountCents })),
      paidBefore: [],
    };
  }

  const inputs = await weekInputs(executor, key);
  const evidence = await weekEvidence(executor, key);
  const saved = week ? await executor.select().from(commissionRoster).where(eq(commissionRoster.weekId, week.id)) : [];
  const settings = await getSettings(executor);
  const through = await bankThrough(executor);
  const savedBy = new Map(saved.map((r) => [r.staffId, r]));
  const rates = commissionRates(settings);
  const roster: RosterEntry[] = people
    .filter((p) => !catchUp && (isWorkingStatus(p.status) || savedBy.has(p.id)))
    .map((p) => {
      const e = evidence.get(p.id) ?? NO_EVIDENCE;
      // The Legal Team is the outside lawyer (2026-11-10): using the app doesn't make them pool staff.
      const suggested = p.role !== "legal" && evidenceTotal(e) > 0;
      return { staffId: p.id, name: p.name, role: p.role, suggested, included: savedBy.get(p.id)?.included ?? suggested, evidence: e };
    })
    .sort((a, b) => Number(b.suggested) - Number(a.suggested) || a.name.localeCompare(b.name));

  return {
    key,
    catchUp,
    label: periodLabel(key),
    from,
    to,
    ended: now >= to,
    bankThrough: through,
    bankCovers: through !== null && through >= to,
    status: "open",
    // The catch-up period has no pool, so there's no roster to lock.
    rosterLocked: catchUp || Boolean(week?.rosterLockedAt),
    roster,
    // Weeks not yet closed use the current rates; closing freezes them.
    rates,
    calculation: calculateWeek({ ...inputs, roster: roster.filter((r) => r.included).map((r) => r.staffId), rates }),
    names,
    awards: null,
    paidBefore: inputs.paidBefore,
  };
}

async function ensureWeek(tx: Tx, key: string) {
  await tx.insert(commissionWeek).values({ weekKey: key }).onConflictDoNothing();
  const [week] = await tx.select().from(commissionWeek).where(eq(commissionWeek.weekKey, key)).for("update");
  return week;
}

export const rosterSchema = z.object({
  weekKey: z.string(),
  included: z.array(z.uuid()).max(200),
  lock: z.boolean().default(false),
});

/** Saves (and optionally locks) the pool roster. Management+. */
export async function saveRoster(viewer: Viewer, raw: z.input<typeof rosterSchema>, now: Date = new Date()): Promise<void> {
  if (!can(viewer.role, "commissions.manage")) throw new ForbiddenError();
  const input = rosterSchema.parse(raw);
  assertWeek(input.weekKey);
  if (input.weekKey === CATCH_UP_KEY) throw new LoanError("The catch-up period has no pool roster.");
  if (input.lock && now < periodRange(input.weekKey).to) throw new LoanError("The roster can be locked once the week has ended.");
  const evidence = await weekEvidence(db, input.weekKey);
  const request = await getRequestMeta();
  await db.transaction(async (tx) => {
    const week = await ensureWeek(tx, input.weekKey);
    if (week.rosterLockedAt) throw new LoanError("This week's roster is locked.");
    const active = await tx.select({ id: staff.id, role: staff.role }).from(staff).where(inArray(staff.status, [...WORKING_STATUSES]));
    const included = new Set(input.included);
    for (const id of included) if (!active.some((a) => a.id === id)) throw new LoanError("Only current staff can be in the pool.");
    for (const { id, role } of active) {
      const e = evidence.get(id) ?? NO_EVIDENCE;
      const row = { weekId: week.id, staffId: id, included: included.has(id), suggested: role !== "legal" && evidenceTotal(e) > 0, evidence: e, decidedByStaffId: viewer.staffId, decidedAt: now };
      await tx
        .insert(commissionRoster)
        .values(row)
        .onConflictDoUpdate({ target: [commissionRoster.weekId, commissionRoster.staffId], set: { included: row.included, suggested: row.suggested, evidence: row.evidence, decidedByStaffId: viewer.staffId, decidedAt: now } });
    }
    if (input.lock) await tx.update(commissionWeek).set({ rosterLockedAt: now, rosterLockedByStaffId: viewer.staffId }).where(eq(commissionWeek.id, week.id));
    await recordAudit(tx, {
      actor: { type: "staff", staffId: viewer.staffId },
      action: input.lock ? "commissions.roster.locked" : "commissions.roster.saved",
      target: { type: "commission_week", id: week.id },
      metadata: { weekKey: input.weekKey, included: [...included] },
      request,
    });
  });
}

/**
 * Freezes the week and books the accrual: Dr 5000 Commission expense / Cr 2000
 * Commissions payable. Management+; the week must have ended and its roster be locked.
 */
export async function closeWeek(viewer: Viewer, weekKey: string, now: Date = new Date()): Promise<{ totalCents: number }> {
  if (!can(viewer.role, "commissions.manage")) throw new ForbiddenError();
  assertWeek(weekKey);
  const request = await getRequestMeta();

  return db.transaction(async (tx) => {
    // Wait for any import or paste in progress, so the figures frozen here are the ones in the books.
    await tx.execute(sql`select pg_advisory_xact_lock(${LOAN_SYNC_LOCK})`);
    await tx.execute(sql`select pg_advisory_xact_lock(${MORTGAGE_SYNC_LOCK})`);
    const week = await ensureWeek(tx, weekKey);
    if (week.status === "closed") throw new LoanError("This week is already closed.");
    const view = await getWeek(weekKey, now, tx);
    if (!view.ended) throw new LoanError("The week hasn't ended yet.");
    if (!view.bankCovers) throw new LoanError(bankNotCoveredMessage(view));
    if (!view.rosterLocked) throw new LoanError("Lock the pool roster first.");
    if (view.calculation.problems.length) {
      throw new LoanError(`Fix ${view.calculation.problems.length} item${view.calculation.problems.length === 1 ? "" : "s"} first (officer missing or banker fee unknown).`);
    }
    const calc = view.calculation;
    const total = [...calc.totals.values()].reduce((s, v) => s + v, 0);
    let entryId: string | null = null;
    if (total > 0) {
      entryId = randomUUID();
      const memo = view.catchUp ? "Commission — catch-up before the scheme started" : `Commission — week of ${view.label}`;
      await tx.insert(journalEntry).values({ id: entryId, effectiveAt: new Date(view.to.getTime() - 1000), kind: "adjustment", description: memo, createdByStaffId: viewer.staffId });
      await tx.insert(journalLine).values([
        { entryId, accountCode: "5000", debitCents: total, creditCents: 0, memo },
        { entryId, accountCode: "2000", debitCents: 0, creditCents: total, memo },
      ]);
    }
    const lines = calc.lines.filter((l) => l.staffId);
    for (let i = 0; i < lines.length; i += 500) {
      await tx.insert(commissionLine).values(
        lines.slice(i, i + 500).map((l) => ({
          weekId: week.id,
          staffId: l.staffId!,
          kind: l.kind,
          label: l.label,
          baseCents: l.baseCents,
          amountCents: l.amountCents,
          sourceTxId: l.sourceTxId ?? null,
          loanId: l.loanId ?? null,
          mortgageId: l.mortgageId ?? null,
        })),
      );
    }
    if (calc.totals.size) await tx.insert(commissionAward).values([...calc.totals].map(([staffId, amountCents]) => ({ weekId: week.id, staffId, amountCents })));
    await tx
      .update(commissionWeek)
      .set({ status: "closed", closedAt: now, closedByStaffId: viewer.staffId, entryId, summary: { pool: calc.pool, companyShareCents: calc.companyShareCents, rates: view.rates } })
      .where(eq(commissionWeek.id, week.id));
    await recordAudit(tx, {
      actor: { type: "staff", staffId: viewer.staffId },
      action: "commissions.week.closed",
      target: { type: "commission_week", id: week.id },
      metadata: { weekKey, totalCents: total, people: calc.totals.size, journalEntryId: entryId },
      request,
    });
    return { totalCents: total };
  });
}

/** Why a period that has ended can't be closed yet: the books don't have the bank's rows to its end. */
export function bankNotCoveredMessage(view: Pick<WeekView, "bankThrough" | "catchUp">): string {
  const through = view.bankThrough ? ` The newest bank row is from ${dayMonth(view.bankThrough)}.` : "";
  return `Import a bank export taken after the ${view.catchUp ? "period" : "week"} ended first, so every receipt in it is counted.${through}`;
}

/**
 * Records commission payouts made after the scheme started, matching them to a
 * person by the target wallet when it's known. Idempotent; runs after imports.
 */
export async function syncPayouts(executor?: Tx): Promise<{ found: number; matched: number }> {
  const run = async (tx: Tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${0x4c4c434d})`); // "LLCM"
    const rows = await tx
      .select({ id: bankTransaction.id, target: bankTransaction.targetWallet })
      .from(bankTransaction)
      .leftJoin(commissionPayout, eq(commissionPayout.bankTransactionId, bankTransaction.id))
      .where(and(eq(bankTransaction.category, "commission"), gte(bankTransaction.occurredAt, COMMISSION_START), isNull(commissionPayout.bankTransactionId)));
    if (rows.length === 0) return { found: 0, matched: 0 };
    const wallets = await tx.select({ id: staff.id, walletId: staff.walletId }).from(staff);
    const byWallet = new Map(wallets.filter((w) => w.walletId).map((w) => [w.walletId!, w.id]));
    let matched = 0;
    for (const r of rows) {
      const staffId = r.target ? byWallet.get(r.target) : undefined;
      await tx.insert(commissionPayout).values({ bankTransactionId: r.id, status: "unmatched" });
      if (staffId) {
        await matchPayout(tx, r.id, staffId, "wallet", null);
        matched++;
      }
    }
    return { found: rows.length, matched };
  };
  return executor ? run(executor) : db.transaction(run);
}

export async function matchPayout(tx: Tx, txId: string, staffId: string, how: string, by: string | null) {
  const [row] = await tx.select({ amount: bankTransaction.amountCents, at: bankTransaction.occurredAt }).from(bankTransaction).where(eq(bankTransaction.id, txId));
  const entryId = randomUUID();
  const memo = "Commission paid — settles what's owed";
  await tx.insert(journalEntry).values({ id: entryId, effectiveAt: row.at, kind: "adjustment", description: memo, bankTransactionId: txId, createdByStaffId: by });
  await tx.insert(journalLine).values([
    { entryId, accountCode: "2000", debitCents: row.amount, creditCents: 0, memo },
    { entryId, accountCode: "5000", debitCents: 0, creditCents: row.amount, memo },
  ]);
  await tx
    .update(commissionPayout)
    .set({ status: "matched", staffId, entryId, matchedBy: how, decidedByStaffId: by, decidedAt: new Date() })
    .where(eq(commissionPayout.bankTransactionId, txId));
}

export const assignPayoutSchema = z.object({
  bankTransactionId: z.uuid(),
  /** A staff member, or "old_scheme" for work before the scheme started (stays an expense). */
  to: z.union([z.uuid(), z.literal("old_scheme")]),
  rememberWallet: z.boolean().default(true),
});

export async function assignPayout(viewer: Viewer, raw: z.input<typeof assignPayoutSchema>): Promise<void> {
  if (!can(viewer.role, "commissions.manage")) throw new ForbiddenError();
  const input = assignPayoutSchema.parse(raw);
  const request = await getRequestMeta();
  await db.transaction(async (tx) => {
    const [p] = await tx
      .select({ status: commissionPayout.status, target: bankTransaction.targetWallet, amount: bankTransaction.amountCents })
      .from(commissionPayout)
      .innerJoin(bankTransaction, eq(bankTransaction.id, commissionPayout.bankTransactionId))
      .where(eq(commissionPayout.bankTransactionId, input.bankTransactionId))
      .for("update");
    if (!p) throw new LoanError("Payout not found.");
    if (p.status !== "unmatched") throw new LoanError("This payout has already been assigned.");
    if (input.to === "old_scheme") {
      await tx
        .update(commissionPayout)
        .set({ status: "old_scheme", decidedByStaffId: viewer.staffId, decidedAt: new Date() })
        .where(eq(commissionPayout.bankTransactionId, input.bankTransactionId));
    } else {
      const [s] = await tx.select().from(staff).where(eq(staff.id, input.to));
      if (!s) throw new LoanError("Staff member not found.");
      await matchPayout(tx, input.bankTransactionId, s.id, "manual", viewer.staffId);
      if (input.rememberWallet && p.target && !s.walletId) {
        const [taken] = await tx.select({ id: staff.id }).from(staff).where(eq(staff.walletId, p.target));
        if (!taken) await tx.update(staff).set({ walletId: p.target, updatedAt: new Date() }).where(eq(staff.id, s.id));
      }
    }
    await recordAudit(tx, {
      actor: { type: "staff", staffId: viewer.staffId },
      action: "commissions.payout.assigned",
      target: { type: "bank_transaction", id: input.bankTransactionId },
      metadata: { to: input.to, amountCents: p.amount, wallet: p.target },
      request,
    });
  });
}
