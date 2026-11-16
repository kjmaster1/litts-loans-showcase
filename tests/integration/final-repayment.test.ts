import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq, isNull, sql } from "drizzle-orm";
import * as XLSX from "xlsx";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { BUSINESS_WALLET, STATE_LENDING_WALLET } from "@/domain/bank/constants";
import { postingLines } from "@/domain/ledger/posting";

vi.mock("@/server/request", () => ({ getRequestMeta: async () => ({ ip: "203.0.113.10", userAgent: "vitest" }) }));

const { commitImport, stageImport } = await import("@/server/bank/import");
const { mortgageSyncPending } = await import("@/server/mortgages/sync");
const { db } = await import("@/server/db");
const { bankTransaction, importBatch, journalEntry, journalLine, mortgage, mortgagePayment, mortgageSettlement, staff } = await import("@/server/db/schema");
const { resetDb } = await import("../support/db");

/**
 * Zion's report (2026-11-06): the game words a mortgage's last instalment "<addr>: Final Loan Repayment". The app only
 * knew "<addr>: Loan Repayment", so both legs of 104 Forum Dr, Apt 1F went to review and the mortgage stayed at 4 of 5.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const FIXTURE = readFileSync("tests/fixtures/bank-export.xlsx");
const COL = { time: 0, amount: 2, source: 4, target: 5, name: 6, stateId: 7, comment: 8, tax: 9 };
const NEW_ROWS = { stateId: 17148, address: "115 North Rockford Dr" };
const REPAIRED = { stateId: 4063, address: "106 North Rockford Dr" };
const MIGRATION = readFileSync("drizzle/0035_final_loan_repayment.sql", "utf8")
  .split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter(Boolean);

let viewer: import("@/server/authz/viewer").Viewer;
let batchId: string;

function grid() {
  const wb = XLSX.read(FIXTURE, { type: "buffer" });
  const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, blankrows: true, defval: null });
  return { name: wb.SheetNames[0], head: rows.slice(0, 6), data: rows.slice(6).filter((r) => r.some((c) => c !== null)) };
}

let day = 46310; // after the fixture's last row (Excel serial date)

/** The bank's two rows for an instalment: the buyer pays Litt's, Litt's forwards the principal to the State. */
function legs(buyer: { stateId: number; address: string }, wording: string, gross: number, tax: number, toState: number) {
  const template = (side: number) => grid().data.find((r) => r[COL.comment] === `${NEW_ROWS.address}: Loan Repayment` && r[side] === BUSINESS_WALLET)!;
  const when = day++;
  const paid = [...template(COL.target)];
  paid[COL.time] = when;
  paid[COL.amount] = gross;
  paid[COL.tax] = tax;
  paid[COL.stateId] = buyer.stateId;
  paid[COL.name] = `Buyer ${buyer.stateId}`;
  paid[COL.comment] = `${buyer.address}: ${wording}`;
  const forwarded = [...template(COL.source)];
  forwarded[COL.time] = when;
  forwarded[COL.amount] = toState;
  forwarded[COL.comment] = `${buyer.address}: ${wording}`;
  return [paid, forwarded];
}

async function importRows(rows: unknown[][]) {
  const g = grid();
  const out = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(out, XLSX.utils.aoa_to_sheet([...g.head, ...rows]), g.name);
  const stagingId = await stageImport(viewer, { name: `later-${day}.xlsx`, bytes: XLSX.write(out, { type: "buffer", bookType: "xlsx" }) });
  await commitImport(viewer, stagingId);
}

const mortgageOf = async (stateId: number) => (await db.select().from(mortgage).where(and(eq(mortgage.buyerStateId, stateId), isNull(mortgage.mergedIntoId))))[0];
const paymentsOf = async (id: string) => db.select().from(mortgagePayment).where(eq(mortgagePayment.mortgageId, id));
const rowsWith = (comment: string) => db.select().from(bankTransaction).where(eq(bankTransaction.comment, comment)).orderBy(bankTransaction.direction);
const entryCount = async () => (await db.select({ id: journalEntry.id }).from(journalEntry)).length;
const balanceOf = async (account: string) => {
  const { rows } = await db.execute<{ b: string }>(sql`select coalesce(sum(debit_cents - credit_cents), 0) as b from journal_line where account_code = ${account}`);
  return Number(rows[0].b);
};

/** One instalment away from the end, whatever the fixture has paid. */
async function oneInstalmentLeft(stateId: number) {
  const m = await mortgageOf(stateId);
  await db.update(mortgage).set({ instalments: (await paymentsOf(m.id)).length + 1 }).where(eq(mortgage.id, m.id));
}

/** A row as it was stored before the fix: unclassified, posted to Needs review. */
async function storedUnclassified(
  tx: Tx,
  row: { comment: string; direction: "in" | "out"; amountCents: number; taxCents?: number; targetWallet?: string; txType?: string; category?: string },
) {
  const taxCents = row.taxCents ?? 0;
  const id = randomUUID();
  const entryId = randomUUID();
  const at = new Date(Date.UTC(2026, 10, 5, 20, 13, 59));
  await tx.insert(bankTransaction).values({
    id,
    batchId,
    walletId: BUSINESS_WALLET,
    occurredAt: at,
    direction: row.direction,
    txType: row.txType ?? "transfer",
    amountCents: row.amountCents,
    taxCents,
    targetWallet: row.targetWallet ?? (row.direction === "out" ? STATE_LENDING_WALLET : BUSINESS_WALLET),
    comment: row.comment,
    fingerprint: `final-${id}`,
    occurrence: 1,
    category: row.category ?? "unclassified",
    confidence: "unclassified",
    rulesetVersion: 1,
    postingEntryId: entryId,
  });
  await tx.insert(journalEntry).values({ id: entryId, effectiveAt: at, kind: "bank_posting", description: row.comment, bankTransactionId: id });
  await tx
    .insert(journalLine)
    .values(postingLines({ direction: row.direction, amountCents: row.amountCents, taxCents, category: "unclassified" }).map((l) => ({ entryId, accountCode: l.account, debitCents: l.debit, creditCents: l.credit, memo: l.memo ?? null })));
}

const runMigration = async (tx: Tx) => {
  for (const s of MIGRATION) await tx.execute(sql.raw(s));
};
const migrate = () => db.transaction(runMigration);
/** Adds `row`, runs the migration and expects it to refuse. Rolled back, so each case stands alone. */
const refusedWith = (row: Parameters<typeof storedUnclassified>[1]) =>
  expect(
    db.transaction(async (tx) => {
      await storedUnclassified(tx, row);
      await runMigration(tx);
    }),
  ).rejects.toMatchObject({ cause: { message: expect.stringContaining("final repayments") } });

beforeAll(async () => {
  await resetDb();
  const [row] = await db.insert(staff).values({ stateId: 424244, characterName: "Final Tester", role: "ceo", status: "active" }).returning();
  viewer = { staffId: row.id, userId: "u-f", sessionId: "s-f", role: "ceo", characterName: "Final Tester", stateId: 424244, username: "f", twoFactorEnabled: true, stepUpAt: null, tourCompletedAt: null, tourRole: null };
  const stagingId = await stageImport(viewer, { name: "export.xlsx", bytes: FIXTURE });
  await commitImport(viewer, stagingId);
  [{ id: batchId }] = await db.select({ id: importBatch.id }).from(importBatch);
});

describe("a mortgage's final instalment in the bank export", () => {
  it("is paired, linked and completes the mortgage, its $70 kept as broker interest", async () => {
    await oneInstalmentLeft(NEW_ROWS.stateId);
    const review = await balanceOf("1900");
    const taxExpense = await balanceOf("5200");
    const brokerInterest = await balanceOf("4110");

    await importRows(legs(NEW_ROWS, "Final Loan Repayment", 1000, 30, 900));

    const comment = `${NEW_ROWS.address}: Final Loan Repayment`;
    const [paid, forwarded] = await rowsWith(comment);
    expect(paid).toMatchObject({ category: "mortgage.repayment_in", confidence: "certain" });
    expect(forwarded).toMatchObject({ category: "mortgage.repayment_out", confidence: "certain" });
    const [settlement] = await db.select().from(mortgageSettlement).where(eq(mortgageSettlement.inTxId, paid.id));
    expect(settlement).toMatchObject({ kind: "repayment", address: NEW_ROWS.address, outTxId: forwarded.id });

    const m = await mortgageOf(NEW_ROWS.stateId);
    expect(m.status).toBe("completed");
    expect((await paymentsOf(m.id)).map((p) => p.bankTransactionId)).toContain(paid.id);
    expect(await balanceOf("1900")).toBe(review);
    expect(await balanceOf("5200")).toBe(taxExpense);
    expect(await balanceOf("4110")).toBe(brokerInterest - 7_000); // credit-natural: more income
  });
});

describe("migration 0035: final instalments stored before the fix", () => {
  const comment = `${REPAIRED.address}: Final Loan Repayment`;

  it("re-posts both legs, and the next import finishes the mortgage; a second run changes nothing", async () => {
    await oneInstalmentLeft(REPAIRED.stateId);
    const review = await balanceOf("1900");
    const taxExpense = await balanceOf("5200");
    const cash = await balanceOf("1000");
    const brokerInterest = await balanceOf("4110");
    await db.transaction(async (tx) => {
      await storedUnclassified(tx, { comment, direction: "in", amountCents: 423_700, taxCents: 11_500 });
      await storedUnclassified(tx, { comment, direction: "out", amountCents: 383_300 });
    });
    expect(await balanceOf("1900")).toBe(review - 40_400); // the $404 stuck in Needs review
    expect(await balanceOf("5200")).toBe(taxExpense + 11_500);

    await migrate();

    const [paid, forwarded] = await rowsWith(comment);
    expect(paid).toMatchObject({ category: "mortgage.repayment_in", confidence: "certain", rulesetVersion: 2, classifiedByStaffId: null });
    expect(forwarded).toMatchObject({ category: "mortgage.repayment_out", confidence: "certain", rulesetVersion: 2, classifiedByStaffId: null });
    expect(await balanceOf("1900")).toBe(review);
    expect(await balanceOf("5200")).toBe(taxExpense);
    expect(await balanceOf("1000")).toBe(cash + 412_200 - 383_300);

    // The same lines an import writes: `postingLines` is the rule, the SQL only mirrors it.
    for (const row of [paid, forwarded]) {
      const lines = await db.select().from(journalLine).where(eq(journalLine.entryId, row.postingEntryId!));
      const expected = postingLines({ direction: row.direction, amountCents: row.amountCents, taxCents: row.taxCents, category: row.category as "mortgage.repayment_in" });
      const shape = (l: { a: string; d: number; c: number; m: string | null }) => `${l.a} ${l.d} ${l.c} ${l.m}`;
      expect(lines.map((l) => shape({ a: l.accountCode, d: l.debitCents, c: l.creditCents, m: l.memo })).sort()).toEqual(
        expected.map((l) => shape({ a: l.account, d: l.debit, c: l.credit, m: l.memo ?? null })).sort(),
      );
      const reversal = await db.select().from(journalEntry).where(and(eq(journalEntry.bankTransactionId, row.id), eq(journalEntry.kind, "reversal")));
      expect(reversal).toHaveLength(1);
      expect(reversal[0].reason).toContain("0035");
    }

    const entries = await entryCount();
    await migrate();
    expect(await entryCount()).toBe(entries);
    expect((await rowsWith(comment)).map((r) => r.postingEntryId)).toEqual([paid.postingEntryId, forwarded.postingEntryId]);

    // Pairing happens on an import; the mortgage completes in the same step.
    expect(await mortgageSyncPending()).toBe(true);
    await importRows(legs({ stateId: 12197, address: "112 West Mirror Drive" }, "Loan Repayment", 1000, 0, 900));
    const [settlement] = await db.select().from(mortgageSettlement).where(eq(mortgageSettlement.inTxId, paid.id));
    expect(settlement).toMatchObject({ kind: "repayment", address: REPAIRED.address, outTxId: forwarded.id });
    expect(await balanceOf("4110")).toBe(brokerInterest - 28_900 - 10_000); // $289 kept, and the other instalment's $100
    const m = await mortgageOf(REPAIRED.stateId);
    expect(m.status).toBe("completed");
    expect((await paymentsOf(m.id)).map((p) => p.bankTransactionId)).toContain(paid.id);
    expect(await mortgageSyncPending()).toBe(false);
  });

  it("refuses a row someone filed by hand", async () => {
    await refusedWith({ comment: "101 Example St: Final Loan Repayment", direction: "in", amountCents: 1000, category: "capital.contribution" });
  });

  it("refuses money sent anywhere but the State", async () => {
    await refusedWith({ comment: "101 Example St: Final Loan Repayment", direction: "out", amountCents: 1000, targetWallet: "69000000" });
  });

  it("refuses anything but a transfer", async () => {
    await refusedWith({ comment: "101 Example St: Final Loan Repayment", direction: "in", amountCents: 1000, txType: "charge" });
  });
});
