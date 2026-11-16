import "server-only";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { CATCH_UP_KEY, COMMISSION_START, dayMonth, periodLabel, weekKeyOf, weekRange, weeksSinceStart } from "@/domain/commissions/week";
import { db } from "@/server/db";
import { bankTransaction, commissionPayout, staff } from "@/server/db/schema";
import { getWeek } from "./service";
import { WORKING_STATUSES } from "@/lib/roles";

/** Read models for the commission pages. */

export type Balance = { staffId: string; name: string; awardedCents: number; paidCents: number; owedCents: number };

/** Owed = awards from closed weeks − payouts matched to the person. */
export async function balances(): Promise<Balance[]> {
  const rows = await db.execute<{ id: string; name: string; awarded: string; paid: string }>(sql`
    select s.id, s.character_name as name,
      coalesce((select sum(a.amount_cents) from commission_award a where a.staff_id = s.id), 0) as awarded,
      coalesce((select sum(b.amount_cents) from commission_payout p join bank_transaction b on b.id = p.bank_transaction_id
                where p.staff_id = s.id and p.status = 'matched'), 0) as paid
    from staff s`);
  return rows.rows
    .map((r) => ({ staffId: r.id, name: r.name, awardedCents: Number(r.awarded), paidCents: Number(r.paid), owedCents: Number(r.awarded) - Number(r.paid) }))
    .filter((b) => b.awardedCents !== 0 || b.paidCents !== 0)
    .sort((a, b) => b.owedCents - a.owedCents);
}

export type WeekSummary = { key: string; catchUp: boolean; label: string; status: "open" | "closed"; ended: boolean; rosterLocked: boolean; totalCents: number; problems: number; current: boolean };

export async function weeksOverview(now: Date = new Date()): Promise<WeekSummary[]> {
  const current = weekKeyOf(now);
  // Newest first; the one-off catch-up period comes last.
  const keys = [...weeksSinceStart(now).reverse(), CATCH_UP_KEY];
  const views = await Promise.all(keys.map((k) => getWeek(k, now)));
  return views.map((v) => ({
    key: v.key,
    catchUp: v.catchUp,
    label: v.label,
    status: v.status,
    ended: v.ended,
    rosterLocked: v.rosterLocked,
    totalCents: [...v.calculation.totals.values()].reduce((s, c) => s + c, 0),
    problems: v.calculation.problems.length,
    current: v.key === current,
  }));
}

export type PayoutRow = {
  txId: string;
  at: Date;
  amountCents: number;
  comment: string;
  targetWallet: string | null;
  status: "unmatched" | "matched" | "old_scheme";
  staffId: string | null;
  staffName: string | null;
  matchedBy: string | null;
};

export async function payouts(limit = 50): Promise<PayoutRow[]> {
  const rows = await db
    .select({
      txId: commissionPayout.bankTransactionId,
      at: bankTransaction.occurredAt,
      amountCents: bankTransaction.amountCents,
      comment: bankTransaction.comment,
      targetWallet: bankTransaction.targetWallet,
      status: commissionPayout.status,
      staffId: commissionPayout.staffId,
      staffName: staff.characterName,
      matchedBy: commissionPayout.matchedBy,
    })
    .from(commissionPayout)
    .innerJoin(bankTransaction, eq(bankTransaction.id, commissionPayout.bankTransactionId))
    .leftJoin(staff, eq(staff.id, commissionPayout.staffId))
    .orderBy(desc(bankTransaction.occurredAt))
    .limit(limit);
  return rows;
}

export type MyCommission = {
  current: { key: string; label: string; estimateCents: number; lines: { kind: string; label: string; amountCents: number }[] } | null;
  balance: Balance | null;
  history: { key: string; label: string; amountCents: number }[];
  payouts: PayoutRow[];
};

/** One person's view: this week's estimate, closed-week awards, payouts and balance. */
export async function myCommission(staffId: string, now: Date = new Date()): Promise<MyCommission> {
  const keys = weeksSinceStart(now);
  const currentKey = keys.at(-1);
  const current = currentKey ? await getWeek(currentKey, now) : null;
  const awards = await db.execute<{ week_key: string; amount: string }>(sql`
    select w.week_key, a.amount_cents as amount from commission_award a join commission_week w on w.id = a.week_id
    where a.staff_id = ${staffId} order by w.week_key desc`);
  const all = await balances();
  const mine = (await payouts(200)).filter((p) => p.staffId === staffId);
  return {
    current:
      current && current.status === "open"
        ? {
            key: current.key,
            label: current.label,
            estimateCents: current.calculation.totals.get(staffId) ?? 0,
            lines: current.calculation.lines.filter((l) => l.staffId === staffId).map((l) => ({ kind: l.kind, label: l.label, amountCents: l.amountCents })),
          }
        : null,
    balance: all.find((b) => b.staffId === staffId) ?? null,
    history: awards.rows.map((a) => ({ key: a.week_key, label: a.week_key === CATCH_UP_KEY ? periodLabel(a.week_key) : `week of ${periodLabel(a.week_key)}`, amountCents: Number(a.amount) })),
    payouts: mine,
  };
}

/** Invited staff included (they can be paid before they sign up), marked as such. */
export async function staffOptions(): Promise<{ id: string; name: string; walletId: string | null }[]> {
  const rows = await db
    .select({ id: staff.id, name: staff.characterName, walletId: staff.walletId, status: staff.status })
    .from(staff)
    .where(inArray(staff.status, [...WORKING_STATUSES]))
    .orderBy(staff.characterName);
  return rows.map((r) => ({ id: r.id, name: r.status === "invited" ? `${r.name} (invite pending)` : r.name, walletId: r.walletId }));
}

export function schemeStarted(now: Date = new Date()): boolean {
  return now >= COMMISSION_START;
}

export type PaySheetRow = {
  staffId: string;
  name: string;
  /** Pay Employee on the phone takes the State ID (a business wallet can't Transfer to a personal one). */
  stateId: number;
  status: string;
  /** Where the payout lands: the import matches it to the person by this wallet. */
  wallet: string | null;
  owedCents: number;
  /** The periods still (partly) unpaid, oldest first — payouts are applied oldest first. */
  periods: { key: string; label: string }[];
  /** What to type as the in-game payment comment. The [COMM] tag makes the import certain. */
  comment: string;
};

const shortWeek = (key: string) => (key === CATCH_UP_KEY ? "catch-up" : `w/c ${dayMonth(weekRange(key).from)}`);

/**
 * One line per person owed commission: everything awarded in closed periods
 * less every payout matched to them (docs/design/COMMISSIONS.md, research/11).
 */
export async function paySheet(): Promise<{ rows: PaySheetRow[]; paidAhead: { name: string; cents: number }[] }> {
  const [awards, people, paid] = await Promise.all([
    db.execute<{ staff_id: string; week_key: string; amount: string }>(sql`
      select a.staff_id, w.week_key, a.amount_cents as amount from commission_award a join commission_week w on w.id = a.week_id where w.status = 'closed'`),
    db.select({ id: staff.id, name: staff.characterName, stateId: staff.stateId, status: staff.status, wallet: staff.walletId }).from(staff),
    db.execute<{ staff_id: string; paid: string }>(sql`
      select p.staff_id, sum(b.amount_cents) as paid from commission_payout p join bank_transaction b on b.id = p.bank_transaction_id
      where p.status = 'matched' group by p.staff_id`),
  ]);
  const paidBy = new Map(paid.rows.map((r) => [r.staff_id, Number(r.paid)]));
  // The catch-up came first, then weeks in order.
  const order = (k: string) => (k === CATCH_UP_KEY ? "0" : `1${k}`);
  const byStaff = new Map<string, { key: string; cents: number }[]>();
  for (const a of awards.rows) byStaff.set(a.staff_id, [...(byStaff.get(a.staff_id) ?? []), { key: a.week_key, cents: Number(a.amount) }]);

  const rows: PaySheetRow[] = [];
  const paidAhead: { name: string; cents: number }[] = [];
  for (const p of people) {
    const list = (byStaff.get(p.id) ?? []).sort((a, b) => order(a.key).localeCompare(order(b.key)));
    const awarded = list.reduce((s, a) => s + a.cents, 0);
    let left = paidBy.get(p.id) ?? 0;
    const owed = awarded - left;
    if (owed < 0) paidAhead.push({ name: p.name, cents: -owed });
    if (owed <= 0) continue;
    const periods: PaySheetRow["periods"] = [];
    for (const a of list) {
      if (left >= a.cents) {
        left -= a.cents;
        continue;
      }
      left = 0;
      periods.push({ key: a.key, label: periodLabel(a.key) });
    }
    rows.push({
      staffId: p.id,
      name: p.name,
      stateId: p.stateId,
      status: p.status,
      wallet: p.wallet,
      owedCents: owed,
      periods,
      comment: `[COMM] Commission Pay: ${periods.map((x) => shortWeek(x.key)).join(", ")}`,
    });
  }
  rows.sort((a, b) => b.owedCents - a.owedCents);
  return { rows, paidAhead };
}
