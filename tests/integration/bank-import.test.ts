import { readFileSync } from "node:fs";
import { count, eq, sql } from "drizzle-orm";
import * as XLSX from "xlsx";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/request", () => ({ getRequestMeta: async () => ({ ip: "203.0.113.10", userAgent: "vitest" }) }));

const { commitImport, cashBalanceCents, getImportPreview, stageImport, ImportError } = await import("@/server/bank/import");
const { reclassifyTransaction } = await import("@/server/bank/reclassify");
const { trialBalance, reviewCount } = await import("@/server/ledger/queries");
const { db } = await import("@/server/db");
const { auditEvent, bankTransaction, journalLine, mortgageSettlement, staff } = await import("@/server/db/schema");
const { resetDb, resetLedger } = await import("../support/db");

const FIXTURE = readFileSync("tests/fixtures/bank-export.xlsx");
const REPORTED = 18_533_100;

let viewer: import("@/server/authz/viewer").Viewer;

/** Builds a partial export keeping the header block and only the given data rows (0-based, newest first). */
function partialExport(keep: (index: number, total: number) => boolean): Uint8Array {
  const wb = XLSX.read(FIXTURE, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, blankrows: true, defval: null });
  const head = grid.slice(0, 6);
  const data = grid.slice(6).filter((r) => r.some((c) => c !== null));
  const out = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([...head, ...data.filter((_, i) => keep(i, data.length))]);
  XLSX.utils.book_append_sheet(out, sheet, wb.SheetNames[0]);
  return XLSX.write(out, { type: "buffer", bookType: "xlsx" });
}

async function importFile(bytes: Uint8Array, name = "export.xlsx") {
  const stagingId = await stageImport(viewer, { name, bytes });
  const preview = await getImportPreview(viewer, stagingId);
  const committed = await commitImport(viewer, stagingId);
  return { preview, committed };
}

async function ledgerTotals() {
  const tb = await trialBalance();
  const debits = tb.reduce((s, r) => s + r.debitCents, 0);
  const credits = tb.reduce((s, r) => s + r.creditCents, 0);
  return { tb, debits, credits };
}

beforeAll(async () => {
  await resetDb();
  const [row] = await db
    .insert(staff)
    .values({ stateId: 424242, characterName: "Import Tester", role: "ceo", status: "active" })
    .returning();
  viewer = {
    staffId: row.id,
    userId: "u",
    sessionId: "s",
    role: "ceo",
    characterName: row.characterName,
    stateId: row.stateId,
    username: "import.tester",
    twoFactorEnabled: true,
    stepUpAt: null,
    tourCompletedAt: null,
    tourRole: null,
  };
});

describe("bank export import", () => {
  beforeEach(resetLedger);

  it("imports the full export and reconciles cash to the reported $185,331", async () => {
    const { preview, committed } = await importFile(FIXTURE);
    expect(preview).toMatchObject({ totalRows: 1922, newRows: 1922, duplicateRows: 0, errors: [], reportedBalanceCents: REPORTED });
    expect(preview.cashAfterCents).toBe(REPORTED);
    expect(committed.newRows).toBe(1922);

    expect(await cashBalanceCents()).toBe(REPORTED);
    const { debits, credits } = await ledgerTotals();
    expect(debits).toBe(credits);
    expect(await reviewCount()).toBe(7);

    const [{ n }] = await db.select({ n: count() }).from(mortgageSettlement);
    expect(n).toBe(42);
  });

  it("is idempotent: importing the same file twice adds nothing", async () => {
    await importFile(FIXTURE);
    const { preview, committed } = await importFile(FIXTURE, "again.xlsx");
    expect(preview).toMatchObject({ newRows: 0, duplicateRows: 1922 });
    expect(committed.newRows).toBe(0);
    expect(await cashBalanceCents()).toBe(REPORTED);
    const [{ n }] = await db.select({ n: count() }).from(bankTransaction);
    expect(n).toBe(1922);
  });

  it("handles overlapping date-range exports without double counting", async () => {
    // Older 60% then newer 60% (20% overlap), as two separate exports.
    const older = partialExport((i, t) => i >= t * 0.4);
    const newer = partialExport((i, t) => i < t * 0.6);
    const first = await importFile(older, "older.xlsx");
    const second = await importFile(newer, "newer.xlsx");
    expect(first.committed.newRows + second.committed.newRows).toBe(1922);
    expect(second.preview.duplicateRows).toBeGreaterThan(300);
    expect(await cashBalanceCents()).toBe(REPORTED);
    const [{ n }] = await db.select({ n: count() }).from(mortgageSettlement);
    expect(n).toBe(42);
  });

  it("pairs a mortgage leg with its partner from an earlier import", async () => {
    // Split exactly between the two legs of the newest mortgage repayment pair.
    const wb = XLSX.read(FIXTURE, { type: "buffer" });
    const grid = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null }).slice(6);
    const inIdx = grid.findIndex((r) => r[8] === "105 South Rockford Dr: Loan Repayment" && r[5] === "69811362");
    const outIdx = grid.findIndex((r) => r[8] === "105 South Rockford Dr: Loan Repayment" && r[4] === "69811362");
    const settled = async () => (await db.select({ n: count() }).from(mortgageSettlement))[0].n;
    await importFile(partialExport((i) => i !== outIdx), "without-out-leg.xlsx");
    expect(await settled()).toBe(41); // the newest pair is missing its out-leg
    const [waiting] = await db.select().from(bankTransaction).where(eq(bankTransaction.comment, grid[inIdx][8] as string)).limit(1);
    expect(waiting).toBeDefined();

    await importFile(partialExport((i) => i === outIdx || i === inIdx), "out-leg.xlsx");
    expect(await settled()).toBe(42); // paired with the leg from the earlier import
    expect(await cashBalanceCents()).toBe(REPORTED);
  });

  it("rejects files that aren't the business wallet's xlsx export", async () => {
    await expect(stageImport(viewer, { name: "x.csv", bytes: Buffer.from("a,b,c") })).rejects.toBeInstanceOf(ImportError);
    const other = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(other, XLSX.utils.aoa_to_sheet([[null, "Wallet ID:", "11111111"], [null, "TIMEZONE:", "UTC-5"], [null, "Amount:", 1], ["Time"]]), "S");
    await expect(stageImport(viewer, { name: "other.xlsx", bytes: XLSX.write(other, { type: "buffer", bookType: "xlsx" }) })).rejects.toThrow(
      /not the business wallet/,
    );
  });

  it("records the import in the audit log", async () => {
    const { committed } = await importFile(FIXTURE);
    const [event] = await db.select().from(auditEvent).where(eq(auditEvent.targetId, committed.batchId));
    expect(event).toMatchObject({ action: "bank.import.committed", actorStaffId: viewer.staffId });
    expect(event.metadata).toMatchObject({ newRows: 1922, unclassified: 7, cashAfterCents: REPORTED });
  });
});

describe("reclassification", () => {
  beforeAll(async () => {
    await resetLedger();
    await importFile(FIXTURE);
  });

  it("reverses and reposts without changing cash, and leaves an audit trail", async () => {
    const [pride] = await db.select().from(bankTransaction).where(eq(bankTransaction.comment, "Transfer: Pride Golf"));
    expect(pride.category).toBe("unclassified");
    await reclassifyTransaction(viewer, { transactionId: pride.id, category: "other_expense", reason: "Company golf day" });

    const [after] = await db.select().from(bankTransaction).where(eq(bankTransaction.id, pride.id));
    expect(after).toMatchObject({ category: "other_expense", confidence: "manual", classifiedByStaffId: viewer.staffId });
    expect(await cashBalanceCents()).toBe(REPORTED);
    expect(await reviewCount()).toBe(6);

    const tb = await trialBalance();
    expect(tb.find((a) => a.code === "5900")?.balanceCents).toBeGreaterThanOrEqual(600_000);
    const [event] = await db.select().from(auditEvent).where(eq(auditEvent.targetId, pride.id));
    expect(event).toMatchObject({ action: "bank.transaction.reclassified", reason: "Company golf day" });
  });

  it("refuses categories that contradict the money's direction", async () => {
    const [row] = await db.select().from(bankTransaction).where(eq(bankTransaction.comment, "Employee Pay: Loan #21 | Payment #1"));
    await expect(reclassifyTransaction(viewer, { transactionId: row.id, category: "capital.contribution", reason: "test" })).rejects.toThrow(
      /doesn't apply to money going out/,
    );
  });

  it("refuses to reclassify game-generated mortgage legs", async () => {
    const [leg] = await db.select().from(bankTransaction).where(eq(bankTransaction.category, "mortgage.repayment_in")).limit(1);
    await expect(reclassifyTransaction(viewer, { transactionId: leg.id, category: "other_income", reason: "test" })).rejects.toThrow(
      /can't be reclassified/,
    );
  });
});

describe("database guarantees", () => {
  it("rejects edits to raw bank data and to journal lines", async () => {
    const [row] = await db.select().from(bankTransaction).limit(1);
    const blocked = { cause: expect.objectContaining({ message: expect.stringMatching(/immutable|append-only/) }) };
    await expect(db.update(bankTransaction).set({ amountCents: 1 }).where(eq(bankTransaction.id, row.id))).rejects.toMatchObject(blocked);
    await expect(db.update(journalLine).set({ debitCents: 1 }).where(eq(journalLine.entryId, row.postingEntryId!))).rejects.toMatchObject(blocked);
    await expect(db.execute(sql`delete from journal_line`)).rejects.toMatchObject(blocked);
  });
});
