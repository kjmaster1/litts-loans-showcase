import { readFileSync } from "node:fs";
import { and, eq, isNull, sql } from "drizzle-orm";
import * as XLSX from "xlsx";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/request", () => ({ getRequestMeta: async () => ({ ip: "203.0.113.10", userAgent: "vitest" }) }));

const { commitImport, stageImport } = await import("@/server/bank/import");
const { mortgageSyncPending, syncMortgages } = await import("@/server/mortgages/sync");
const { previewTablet } = await import("@/server/mortgages/tablet");
const { listMortgages, mortgageKpis } = await import("@/server/mortgages/queries");
const { db } = await import("@/server/db");
const { bankTransaction, mortgage, mortgageEvent, mortgagePayment, staff } = await import("@/server/db/schema");
const { resetDb } = await import("../support/db");

/**
 * Zion's report (2026-10-28): the server renumbers houses and gives old numbers to other houses. In production
 * 115 North Rockford Dr was one buyer's, became 112 then 113; another buyer's 114 became 115, and her repayment was
 * filed under the first buyer's mortgage. The fixture has the first house (anonymised: #17148, 115 North Rockford Dr)
 * and another on the street (#4063, 106 North Rockford Dr).
 */

const FIXTURE = readFileSync("tests/fixtures/bank-export.xlsx");
const SAMPLE = readFileSync("tests/fixtures/paste-mortgage.txt", "utf8");
const COL = { time: 0, amount: 2, name: 6, stateId: 7, comment: 8, tax: 9 };
const FIRST = { stateId: 17148, address: "115 North Rockford Dr" };
const SECOND = { stateId: 4063, address: "106 North Rockford Dr" };
const MIGRATION = readFileSync("drizzle/0034_renumbered_repayments.sql", "utf8")
  .split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter(Boolean);

let viewer: import("@/server/authz/viewer").Viewer;

function grid() {
  const wb = XLSX.read(FIXTURE, { type: "buffer" });
  const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, blankrows: true, defval: null });
  return { name: wb.SheetNames[0], head: rows.slice(0, 6), data: rows.slice(6).filter((r) => r.some((c) => c !== null)) };
}

let day = 46310; // after the fixture's last row (Excel serial date)
/** A repayment by `stateId` under `address`, a day after the previous one. */
function repayment(stateId: number, address: string, amount = 1000) {
  const template = grid().data.find((r) => r[COL.comment] === `${FIRST.address}: Loan Repayment`)!;
  const row = [...template];
  row[COL.time] = day++;
  row[COL.amount] = amount;
  row[COL.stateId] = stateId;
  row[COL.name] = `Buyer ${stateId}`;
  row[COL.comment] = `${address}: Loan Repayment`;
  row[COL.tax] = 0;
  return row;
}

async function importRows(rows: unknown[][]) {
  const g = grid();
  const out = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(out, XLSX.utils.aoa_to_sheet([...g.head, ...rows]), g.name);
  const stagingId = await stageImport(viewer, { name: `later-${day}.xlsx`, bytes: XLSX.write(out, { type: "buffer", bookType: "xlsx" }) });
  await commitImport(viewer, stagingId);
}

const mortgageOf = async (stateId: number) => (await db.select().from(mortgage).where(and(eq(mortgage.buyerStateId, stateId), isNull(mortgage.mergedIntoId))))[0];
const paidFor = async (stateId: number) => {
  const m = await mortgageOf(stateId);
  return db
    .select({ comment: bankTransaction.comment, payer: bankTransaction.initiatorStateId })
    .from(mortgagePayment)
    .innerJoin(bankTransaction, eq(bankTransaction.id, mortgagePayment.bankTransactionId))
    .where(eq(mortgagePayment.mortgageId, m.id))
    .orderBy(bankTransaction.occurredAt);
};

beforeAll(async () => {
  await resetDb();
  const [row] = await db.insert(staff).values({ stateId: 424243, characterName: "Renumber Tester", role: "ceo", status: "active" }).returning();
  viewer = { staffId: row.id, userId: "u-r", sessionId: "s-r", role: "ceo", characterName: "Renumber Tester", stateId: 424243, username: "r", twoFactorEnabled: true, stepUpAt: null, tourCompletedAt: null, tourRole: null };
  const stagingId = await stageImport(viewer, { name: "export.xlsx", bytes: FIXTURE });
  await commitImport(viewer, stagingId);
});

describe("repayments after the server renumbers houses", () => {
  it("links a buyer's repayment under a new address to their mortgage, which takes the new address", async () => {
    // In the fixture already: #12197's house went from 119 to 112 West Mirror Drive before her first repayment.
    expect(await mortgageOf(12197)).toMatchObject({ address: "112 West Mirror Drive", addressAliases: ["119 West Mirror Drive"] });
    expect((await mortgageKpis(viewer)).unlinkedRepayments).toBe(0);

    await importRows([repayment(FIRST.stateId, "112 North Rockford Dr")]);
    expect(await mortgageOf(FIRST.stateId)).toMatchObject({ address: "112 North Rockford Dr", addressAliases: [FIRST.address] });
    expect((await paidFor(FIRST.stateId)).map((p) => p.comment)).toEqual([`${FIRST.address}: Loan Repayment`, "112 North Rockford Dr: Loan Repayment"]);
    const m = await mortgageOf(FIRST.stateId);
    const events = await db.select().from(mortgageEvent).where(and(eq(mortgageEvent.mortgageId, m.id), eq(mortgageEvent.kind, "address_changed")));
    expect(events.map((e) => e.detail)).toEqual([{ from: FIRST.address, to: "112 North Rockford Dr", source: "bank" }]);
  });

  it("files a repayment under the payer's own mortgage when its address used to be another buyer's", async () => {
    await importRows([repayment(SECOND.stateId, FIRST.address), repayment(FIRST.stateId, "113 North Rockford Dr")]);
    expect((await paidFor(SECOND.stateId)).map((p) => p.payer)).toEqual([SECOND.stateId]);
    expect((await paidFor(FIRST.stateId)).every((p) => p.payer === FIRST.stateId)).toBe(true);
    expect(await paidFor(FIRST.stateId)).toHaveLength(3);
    expect(await mortgageOf(SECOND.stateId)).toMatchObject({ address: FIRST.address, addressAliases: [SECOND.address] });
    expect(await mortgageOf(FIRST.stateId)).toMatchObject({ address: "113 North Rockford Dr", addressAliases: [FIRST.address, "112 North Rockford Dr"] });
    expect(await mortgageSyncPending()).toBe(false);
    expect(await syncMortgages()).toMatchObject({ paymentsLinked: 0, unlinkedPayments: 0 });
  });

  it("finds a mortgage by a former address", async () => {
    const found = await listMortgages(viewer, { q: "112 North Rockford", status: "all" });
    expect(found.map((m) => m.buyerStateId)).toEqual([FIRST.stateId]);
  });

  it("doesn't match a tablet agreement to another buyer's mortgage that once had its address", async () => {
    // The fixture's agreement (buyer #1632) moved to the first buyer's old number.
    const { items } = await previewTablet(viewer, { text: SAMPLE.replace("117 Invention Ct", "112 North Rockford Dr") });
    const first = await mortgageOf(FIRST.stateId);
    expect(items[0].match.kind === "matched" && items[0].match.mortgageId).not.toBe(first.id);
    expect(items[0].match).toMatchObject({ kind: "matched", how: "buyer and amounts (the address has changed)" });
  });
});

describe("migration 0034: repayments filed under another buyer's mortgage before the fix", () => {
  it("unlinks them so the next sync files them under the payer's mortgage; a second run changes nothing", async () => {
    const first = await mortgageOf(FIRST.stateId);
    const second = await mortgageOf(SECOND.stateId);
    // What the old sync did: the second buyer's repayment under 115 went to the first buyer's mortgage.
    const [misfiled] = await db
      .select({ id: bankTransaction.id })
      .from(bankTransaction)
      .where(and(eq(bankTransaction.initiatorStateId, SECOND.stateId), eq(bankTransaction.comment, `${FIRST.address}: Loan Repayment`)));
    await db.update(mortgagePayment).set({ mortgageId: first.id }).where(eq(mortgagePayment.bankTransactionId, misfiled.id));
    expect(await paidFor(FIRST.stateId)).toHaveLength(4);

    const run = () => db.transaction(async (tx) => {
      for (const s of MIGRATION) await tx.execute(sql.raw(s));
    });
    await run();
    expect(await paidFor(FIRST.stateId)).toHaveLength(3);
    expect(await mortgageSyncPending()).toBe(true);
    expect(await syncMortgages()).toMatchObject({ paymentsLinked: 1 });
    const [link] = await db.select().from(mortgagePayment).where(eq(mortgagePayment.bankTransactionId, misfiled.id));
    expect(link.mortgageId).toBe(second.id);

    const before = (await db.select().from(mortgagePayment)).length;
    await run();
    expect((await db.select().from(mortgagePayment)).length).toBe(before);
  });

  it("stops, changing nothing, if a misfiled repayment has its own booking", async () => {
    const first = await mortgageOf(FIRST.stateId);
    const [misfiled] = await db
      .select({ id: bankTransaction.id })
      .from(bankTransaction)
      .where(and(eq(bankTransaction.initiatorStateId, SECOND.stateId), eq(bankTransaction.comment, `${FIRST.address}: Loan Repayment`)));
    const [entry] = await db.execute<{ id: string }>(sql`select id from journal_entry limit 1`).then((r) => r.rows);
    await db.update(mortgagePayment).set({ mortgageId: first.id, entryId: entry.id }).where(eq(mortgagePayment.bankTransactionId, misfiled.id));
    await expect(
      db.transaction(async (tx) => {
        for (const s of MIGRATION) await tx.execute(sql.raw(s));
      }),
    ).rejects.toThrow();
    expect(await paidFor(FIRST.stateId)).toHaveLength(4);
  });
});
