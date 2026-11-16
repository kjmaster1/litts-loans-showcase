import "server-only";
import { and, asc, count, desc, eq, gte, ilike, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import { CATEGORIES, type Category } from "@/domain/ledger/categories";
import { cleanSearch } from "@/lib/search";
import { db } from "@/server/db";
import { bankTransaction, importBatch, journalEntry, journalLine, ledgerAccount, staff } from "@/server/db/schema";

/** Read models for the finance pages. Callers must hold `finance.view`. */

export type AccountType = "asset" | "liability" | "equity" | "income" | "expense" | "memo";

export type TrialBalanceRow = {
  code: string;
  name: string;
  type: AccountType;
  debitCents: number;
  creditCents: number;
  /** Signed in the account's natural direction (assets/expenses debit-positive, others credit-positive). */
  balanceCents: number;
};

const DEBIT_NATURAL: ReadonlySet<AccountType> = new Set(["asset", "expense"]);
/** Memo accounts that accumulate debits (the tax-withheld memo); their contras are credit-natural. */
const DEBIT_NATURAL_MEMO: ReadonlySet<string> = new Set(["9000"]);

export function naturalBalance(type: AccountType, debit: number, credit: number, code?: string): number {
  const debitNatural = DEBIT_NATURAL.has(type) || (type === "memo" && code !== undefined && DEBIT_NATURAL_MEMO.has(code));
  return debitNatural ? debit - credit : credit - debit;
}

export async function trialBalance(opts: { before?: Date } = {}): Promise<TrialBalanceRow[]> {
  const sums = db
    .select({
      code: journalLine.accountCode,
      d: sql<string>`sum(${journalLine.debitCents})`.as("d"),
      c: sql<string>`sum(${journalLine.creditCents})`.as("c"),
    })
    .from(journalLine)
    .innerJoin(journalEntry, eq(journalEntry.id, journalLine.entryId))
    .where(opts.before ? lt(journalEntry.effectiveAt, opts.before) : undefined)
    .groupBy(journalLine.accountCode)
    .as("sums");

  const rows = await db
    .select({ code: ledgerAccount.code, name: ledgerAccount.name, type: ledgerAccount.type, d: sums.d, c: sums.c })
    .from(ledgerAccount)
    .leftJoin(sums, eq(sums.code, ledgerAccount.code))
    .orderBy(asc(ledgerAccount.code));

  return rows.map((r) => {
    const debit = Number(r.d ?? 0);
    const credit = Number(r.c ?? 0);
    return { code: r.code, name: r.name, type: r.type, debitCents: debit, creditCents: credit, balanceCents: naturalBalance(r.type, debit, credit, r.code) };
  });
}

/** Income and expense totals between two instants (income positive, expenses positive). */
export async function profitAndLoss(from: Date, to: Date) {
  const rows = await db
    .select({
      code: ledgerAccount.code,
      name: ledgerAccount.name,
      type: ledgerAccount.type,
      d: sql<string>`coalesce(sum(${journalLine.debitCents}), 0)`,
      c: sql<string>`coalesce(sum(${journalLine.creditCents}), 0)`,
    })
    .from(journalLine)
    .innerJoin(journalEntry, eq(journalEntry.id, journalLine.entryId))
    .innerJoin(ledgerAccount, eq(ledgerAccount.code, journalLine.accountCode))
    .where(and(inArray(ledgerAccount.type, ["income", "expense"]), gte(journalEntry.effectiveAt, from), lt(journalEntry.effectiveAt, to)))
    .groupBy(ledgerAccount.code, ledgerAccount.name, ledgerAccount.type)
    .orderBy(asc(ledgerAccount.code));
  const lines = rows.map((r) => ({
    code: r.code,
    name: r.name,
    type: r.type as "income" | "expense",
    amountCents: naturalBalance(r.type, Number(r.d), Number(r.c)),
  }));
  const income = lines.filter((l) => l.type === "income").reduce((s, l) => s + l.amountCents, 0);
  const expenses = lines.filter((l) => l.type === "expense").reduce((s, l) => s + l.amountCents, 0);
  return { lines, incomeCents: income, expenseCents: expenses, netCents: income - expenses };
}

export async function accountByCode(code: string) {
  return db.query.ledgerAccount.findFirst({ where: eq(ledgerAccount.code, code) });
}

export type AccountActivityRow = {
  lineId: number;
  effectiveAt: Date;
  description: string;
  kind: string;
  debitCents: number;
  creditCents: number;
  memo: string | null;
  bankTransactionId: string | null;
};

export type ActivityCursor = { effectiveAt: Date; lineId: number };

export function encodeCursor(c: ActivityCursor): string {
  return `${c.effectiveAt.getTime()}_${c.lineId}`;
}

export function decodeCursor(value: string | undefined): ActivityCursor | undefined {
  const m = value ? /^(\d{1,15})_(\d{1,15})$/.exec(value) : null;
  return m ? { effectiveAt: new Date(Number(m[1])), lineId: Number(m[2]) } : undefined;
}

/**
 * Lines posted to an account, newest first. Keyset pagination on
 * (effective date, line id) — the same order as the sort, so pages never skip
 * or repeat rows even when older-dated entries are posted later.
 */
export async function accountActivity(code: string, opts: { before?: ActivityCursor; pageSize?: number } = {}) {
  const pageSize = opts.pageSize ?? 50;
  const cursor = opts.before
    ? sql`(${journalEntry.effectiveAt}, ${journalLine.id}) < (${opts.before.effectiveAt.toISOString()}::timestamptz, ${opts.before.lineId})`
    : undefined;
  const rows = await db
    .select({
      lineId: journalLine.id,
      effectiveAt: journalEntry.effectiveAt,
      description: journalEntry.description,
      kind: journalEntry.kind,
      debitCents: journalLine.debitCents,
      creditCents: journalLine.creditCents,
      memo: journalLine.memo,
      bankTransactionId: journalEntry.bankTransactionId,
    })
    .from(journalLine)
    .innerJoin(journalEntry, eq(journalEntry.id, journalLine.entryId))
    .where(and(eq(journalLine.accountCode, code), cursor))
    .orderBy(desc(journalEntry.effectiveAt), desc(journalLine.id))
    .limit(pageSize + 1);
  return { rows: rows.slice(0, pageSize) as AccountActivityRow[], hasMore: rows.length > pageSize };
}

export type TransactionFilter = {
  q?: string;
  category?: Category;
  review?: boolean;
  direction?: "in" | "out";
  page?: number;
};

export async function listBankTransactions(filter: TransactionFilter, pageSize = 50) {
  const where: SQL[] = [];
  if (filter.category) where.push(eq(bankTransaction.category, filter.category));
  if (filter.review) where.push(eq(bankTransaction.category, "unclassified"));
  if (filter.direction) where.push(eq(bankTransaction.direction, filter.direction));
  const q = cleanSearch(filter.q);
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const parts: SQL[] = [ilike(bankTransaction.comment, like), ilike(bankTransaction.initiatorName, like)];
    if (/^\d{1,9}$/.test(q)) {
      parts.push(eq(bankTransaction.initiatorStateId, Number(q)));
      parts.push(eq(bankTransaction.sourceWallet, q), eq(bankTransaction.targetWallet, q));
    }
    where.push(or(...parts)!);
  }
  const condition = where.length ? and(...where) : undefined;
  const page = Math.max(1, filter.page ?? 1);

  const [rows, [{ total }]] = await Promise.all([
    db
      .select()
      .from(bankTransaction)
      .where(condition)
      .orderBy(desc(bankTransaction.occurredAt), desc(bankTransaction.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ total: count() }).from(bankTransaction).where(condition),
  ]);
  return { rows, total, page, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

export async function reviewCount(): Promise<number> {
  const [{ n }] = await db.select({ n: count() }).from(bankTransaction).where(eq(bankTransaction.category, "unclassified"));
  return n;
}

export async function getBankTransaction(id: string) {
  const tx = await db.query.bankTransaction.findFirst({ where: eq(bankTransaction.id, id) });
  if (!tx) return null;
  const entries = await db
    .select()
    .from(journalEntry)
    .where(eq(journalEntry.bankTransactionId, id))
    // A reclassification records its reversal and new posting together; show the
    // reversal first so the story reads original → reversal → replacement.
    .orderBy(asc(journalEntry.recordedAt), sql`${journalEntry.kind} = 'reversal' desc`);
  const lines = entries.length
    ? await db
        .select()
        .from(journalLine)
        .where(inArray(journalLine.entryId, entries.map((e) => e.id)))
        .orderBy(asc(journalLine.id))
    : [];
  const staffIds = [...new Set([...entries.map((e) => e.createdByStaffId), tx.classifiedByStaffId])].filter(
    (id): id is string => Boolean(id),
  );
  const people = staffIds.length
    ? await db.select({ id: staff.id, name: staff.characterName }).from(staff).where(inArray(staff.id, staffIds))
    : [];
  const nameOf = new Map(people.map((p) => [p.id, p.name]));
  return {
    tx,
    entries: entries.map((e) => ({
      ...e,
      createdBy: e.createdByStaffId ? (nameOf.get(e.createdByStaffId) ?? null) : null,
      lines: lines.filter((l) => l.entryId === e.id),
    })),
    classifiedBy: tx.classifiedByStaffId ? (nameOf.get(tx.classifiedByStaffId) ?? null) : null,
  };
}

export async function listImportBatches(limit = 20) {
  return db
    .select({
      id: importBatch.id,
      fileName: importBatch.fileName,
      createdAt: importBatch.createdAt,
      firstTxAt: importBatch.firstTxAt,
      lastTxAt: importBatch.lastTxAt,
      rowCount: importBatch.rowCount,
      newCount: importBatch.newCount,
      duplicateCount: importBatch.duplicateCount,
      reportedBalanceCents: importBatch.reportedBalanceCents,
      createdBy: staff.characterName,
    })
    .from(importBatch)
    .leftJoin(staff, eq(staff.id, importBatch.createdByStaffId))
    .orderBy(desc(importBatch.createdAt))
    .limit(limit);
}

export async function getImportBatch(id: string) {
  const [batch] = await db
    .select({ batch: importBatch, createdBy: staff.characterName })
    .from(importBatch)
    .leftJoin(staff, eq(staff.id, importBatch.createdByStaffId))
    .where(eq(importBatch.id, id));
  if (!batch) return null;
  const categories = await db
    .select({ category: bankTransaction.category, n: count(), cents: sql<string>`sum(${bankTransaction.amountCents})` })
    .from(bankTransaction)
    .where(eq(bankTransaction.batchId, id))
    .groupBy(bankTransaction.category)
    .orderBy(desc(count()));
  return {
    ...batch.batch,
    createdBy: batch.createdBy,
    categories: categories.map((c) => ({ category: c.category as Category, label: CATEGORIES[c.category as Category]?.label ?? c.category, count: c.n, amountCents: Number(c.cents) })),
  };
}

/** Monthly tax: withheld at source vs the bank's monthly "Tax Payment" record (UTC months). */
export async function taxByMonth() {
  const rows = await db
    .select({
      month: sql<string>`to_char(date_trunc('month', ${bankTransaction.occurredAt} at time zone 'UTC'), 'YYYY-MM')`,
      withheld: sql<string>`sum(case when ${bankTransaction.direction} = 'in' then ${bankTransaction.taxCents} else 0 end)`,
      recorded: sql<string>`sum(case when ${bankTransaction.category} = 'tax.remittance_record' then ${bankTransaction.amountCents} else 0 end)`,
    })
    .from(bankTransaction)
    .groupBy(sql`1`)
    .orderBy(sql`1`);
  return rows.map((r) => ({ month: r.month, withheldCents: Number(r.withheld), recordedCents: Number(r.recorded) }));
}

/**
 * Closing cash (account 1000) for each of the last `days` UK calendar days, for the
 * dashboard and finance charts (redesign 2026-10). Days without movements carry the
 * previous balance forward.
 */
export async function cashHistory(days = 90, now: Date = new Date()): Promise<{ day: string; cents: number }[]> {
  const rows = (
    await db.execute<{ day: string; net: string }>(sql`
      select to_char(e.effective_at at time zone 'Europe/London', 'YYYY-MM-DD') as day, sum(l.debit_cents - l.credit_cents) as net
      from journal_line l join journal_entry e on e.id = l.entry_id
      where l.account_code = '1000'
      group by 1 order by 1`)
  ).rows;
  const byDay = new Map(rows.map((r) => [r.day, Number(r.net)]));
  const key = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const start = key(new Date(now.getTime() - (days - 1) * 86_400_000));
  let balance = rows.filter((r) => r.day < start).reduce((s, r) => s + Number(r.net), 0);
  const out: { day: string; cents: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = key(new Date(now.getTime() - i * 86_400_000));
    balance += byDay.get(day) ?? 0;
    out.push({ day, cents: balance });
  }
  return out;
}
