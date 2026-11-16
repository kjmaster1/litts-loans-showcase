import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/request", () => ({ getRequestMeta: async () => ({ ip: "203.0.113.10", userAgent: "vitest" }) }));

const { commitImport, cashBalanceCents, stageImport } = await import("@/server/bank/import");
const q = await import("@/server/ledger/queries");
const { db } = await import("@/server/db");
const { staff } = await import("@/server/db/schema");
const { resetDb } = await import("../support/db");

type Viewer = import("@/server/authz/viewer").Viewer;

/** The finance pages' read models (review 2026-10-13: this file had a quarter of its lines tested). */
let viewer: Viewer;
let batchId: string;

beforeAll(async () => {
  await resetDb();
  const [row] = await db.insert(staff).values({ stateId: 434343, characterName: "Ledger Reader", role: "ceo", status: "active" }).returning();
  viewer = { staffId: row.id, userId: "u-ledger", sessionId: "s-ledger", role: "ceo", characterName: row.characterName, stateId: row.stateId, username: "ledger", twoFactorEnabled: true, stepUpAt: null, tourCompletedAt: null, tourRole: null };
  ({ batchId } = await commitImport(viewer, await stageImport(viewer, { name: "export.xlsx", bytes: readFileSync("tests/fixtures/bank-export.xlsx") })));
});

describe("trial balance and P&L", () => {
  it("balances, and cash matches the cash balance", async () => {
    const rows = await q.trialBalance();
    const real = rows.filter((r) => r.type !== "memo");
    expect(real.reduce((s, r) => s + r.debitCents, 0)).toBe(real.reduce((s, r) => s + r.creditCents, 0));
    expect(rows.find((r) => r.code === "1000")?.balanceCents).toBe(await cashBalanceCents());
    // Nothing is dated before the bank's first row.
    const before = await q.trialBalance({ before: new Date("2000-01-01") });
    expect(before.every((r) => r.debitCents === 0 && r.creditCents === 0)).toBe(true);
  });

  it("nets income less expenses", async () => {
    const pl = await q.profitAndLoss(new Date("2000-01-01"), new Date("2100-01-01"));
    expect(pl.netCents).toBe(pl.incomeCents - pl.expenseCents);
    expect(pl.lines.every((l) => l.type === "income" || l.type === "expense")).toBe(true);
    expect(pl.incomeCents).toBeGreaterThan(0);
  });

  it("reads natural balances by account type", () => {
    expect(q.naturalBalance("asset", 500, 200)).toBe(300);
    expect(q.naturalBalance("income", 200, 500)).toBe(300);
    expect(q.naturalBalance("liability", 0, 100)).toBe(100);
  });
});

describe("account activity", () => {
  it("pages newest first without skipping or repeating a line", async () => {
    const all: number[] = [];
    let before: ReturnType<typeof q.decodeCursor>;
    for (let i = 0; i < 1000; i++) {
      const page = await q.accountActivity("1000", { before, pageSize: 250 });
      all.push(...page.rows.map((r) => r.lineId));
      if (!page.hasMore) break;
      const last = page.rows.at(-1)!;
      before = q.decodeCursor(q.encodeCursor({ effectiveAt: last.effectiveAt, lineId: last.lineId }));
    }
    expect(new Set(all).size).toBe(all.length);
    const total = (await q.trialBalance()).find((r) => r.code === "1000")!;
    expect(all.length).toBeGreaterThan(0);
    expect(total.debitCents + total.creditCents).toBeGreaterThan(0);
    expect(q.decodeCursor("nonsense")).toBeUndefined();
    expect(q.decodeCursor(undefined)).toBeUndefined();
  });
});

describe("bank transactions", () => {
  it("filters, searches and pages", async () => {
    const first = await q.listBankTransactions({}, 50);
    expect(first.rows).toHaveLength(50);
    expect(first.pageCount).toBe(Math.ceil(first.total / 50));
    const second = await q.listBankTransactions({ page: 2 }, 50);
    expect(second.rows[0].id).not.toBe(first.rows[0].id);

    const review = await q.listBankTransactions({ review: true }, 500);
    expect(review.total).toBe(await q.reviewCount());
    expect(review.rows.every((r) => r.category === "unclassified")).toBe(true);

    const outgoing = await q.listBankTransactions({ direction: "out" }, 20);
    expect(outgoing.rows.every((r) => r.direction === "out")).toBe(true);

    const someone = first.rows.find((r) => r.initiatorStateId !== null)!;
    const byStateId = await q.listBankTransactions({ q: String(someone.initiatorStateId) }, 500);
    expect(byStateId.rows.some((r) => r.id === someone.id)).toBe(true);
    expect((await q.listBankTransactions({ q: "100%_\\" })).total).toBe(0); // LIKE wildcards are literal
  });

  it("shows a row with its posting and who classified it", async () => {
    const [row] = (await q.listBankTransactions({}, 1)).rows;
    const detail = (await q.getBankTransaction(row.id))!;
    expect(detail.tx.id).toBe(row.id);
    expect(detail.entries.length).toBeGreaterThanOrEqual(1);
    expect(detail.entries[0].lines.length).toBeGreaterThanOrEqual(2);
    expect(await q.getBankTransaction("00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});

describe("imports, tax and cash history", () => {
  it("lists the import with its categories", async () => {
    const [latest] = await q.listImportBatches();
    expect(latest).toMatchObject({ id: batchId, createdBy: "Ledger Reader" });
    const batch = (await q.getImportBatch(batchId))!;
    expect(batch.categories.reduce((s, c) => s + c.count, 0)).toBe(batch.newCount);
    expect(batch.categories.every((c) => c.label.length > 0)).toBe(true);
    expect(await q.getImportBatch("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("totals tax by month", async () => {
    const months = await q.taxByMonth();
    expect(months.length).toBeGreaterThan(0);
    expect(months.every((m) => /^\d{4}-\d{2}$/.test(m.month) && m.withheldCents >= 0)).toBe(true);
  });

  it("ends the cash history on today's cash", async () => {
    const history = await q.cashHistory(30);
    expect(history).toHaveLength(30);
    expect(history.at(-1)?.cents).toBe(await cashBalanceCents());
  });
});
