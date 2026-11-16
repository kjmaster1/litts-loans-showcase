import { readFileSync } from "node:fs";
import * as XLSX from "xlsx";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/request", () => ({ getRequestMeta: async () => ({ ip: "203.0.113.10", userAgent: "vitest" }) }));

const { commitImport, stageImport } = await import("@/server/bank/import");
const { commitPaste } = await import("@/server/loans/paste");
const { buildReport, parseRange } = await import("@/server/reports/reports");
const { reportToXlsx } = await import("@/server/reports/xlsx");
const { profitAndLoss } = await import("@/server/ledger/queries");
const { db } = await import("@/server/db");
const { staff } = await import("@/server/db/schema");
const { resetDb } = await import("../support/db");

type Viewer = import("@/server/authz/viewer").Viewer;
let ceo: Viewer;

beforeAll(async () => {
  await resetDb();
  const [row] = await db.insert(staff).values({ stateId: 424242, characterName: "Report Tester", role: "ceo", status: "active" }).returning();
  ceo = { staffId: row.id, userId: "u", sessionId: "s", role: "ceo", characterName: row.characterName, stateId: row.stateId, username: "r", twoFactorEnabled: true, stepUpAt: null, tourCompletedAt: null, tourRole: null };
  await commitImport(ceo, await stageImport(ceo, { name: "export.xlsx", bytes: readFileSync("tests/fixtures/bank-export.xlsx") }));
  // Terms come from the phone cards (health needs the schedules).
  for (const tab of ["active", "overdue", "default", "complete"] as const) await commitPaste(ceo, { tab, text: readFileSync(`tests/fixtures/paste-${tab}.txt`, "utf8") });
});

describe("reports", () => {
  const range = parseRange("2026-01-01", "2026-10-09");

  it("parses UK calendar ranges (inclusive end, BST-aware)", () => {
    expect(range.from.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(range.to.toISOString()).toBe("2026-10-09T23:00:00.000Z"); // midnight BST on 10 Oct
    expect(parseRange("2026-10-09", "2026-01-01").toKey).toBe("2026-10-09"); // end before start → single day
    expect(parseRange("nonsense", undefined, new Date("2026-10-10T12:00:00Z")).fromKey).toBe("2026-01-01");
  });

  it("profit & loss: months add up to the total, which matches the ledger", async () => {
    const r = await buildReport(ceo, "pnl", range);
    const net = r.tables.find((t) => t.title === "Net profit")!.rows[0];
    const monthKeys = r.tables[0].columns.filter((c) => /^\d{4}-\d{2}$/.test(c.key)).map((c) => c.key);
    expect(monthKeys).toHaveLength(10);
    expect(monthKeys.reduce((s, k) => s + Number(net[k]), 0)).toBe(net.total);
    expect(net.total).toBe((await profitAndLoss(range.from, range.to)).netCents);
  });

  it("balance sheet balances: assets = liabilities + equity (incl. profit to date)", async () => {
    const r = await buildReport(ceo, "balance", range);
    const [assets, liabilities, equity] = r.tables.map((t) => Number(t.total!.amount));
    expect(assets).toBe(liabilities + equity);
    expect(r.tables[0].rows.find((x) => String(x.account).startsWith("1000"))?.amount).toBe(18_533_100);
  });

  it("book and tax reports cover the period", async () => {
    const book = await buildReport(ceo, "book", range);
    expect(book.tables[0].rows.length).toBeGreaterThan(50);
    expect(book.tables[1].rows.length).toBe(27);
    const tax = await buildReport(ceo, "tax", range);
    expect(Number(tax.tables[0].total!.withheld)).toBeGreaterThan(0);
  });

  it("loan performance adds up across size, rate, officer and month", async () => {
    const r = await buildReport(ceo, "portfolio", range);
    expect(r.tables.map((t) => t.title)).toEqual([
      "Overall",
      "By size",
      "By rate",
      "By officer",
      "By month opened",
      "Concentration",
      "By borrower",
      "Mortgages by officer",
      "Best finished loans",
      "Worst finished loans",
    ]);
    const [all] = r.tables[0].rows;
    const total = (i: number, k: string) => r.tables[i].rows.reduce((s, row) => s + Number(row[k]), 0);
    for (const i of [1, 3, 4]) {
      expect(total(i, "loans")).toBe(all.loans);
      expect(total(i, "bad")).toBe(all.bad);
      expect(total(i, "lent")).toBe(all.lent);
    }
    expect(Number(all.running) + Number(all.repaid) + Number(all.bad)).toBe(all.loans);
    // Net to Litt's (from the books) adds up the same way, and the borrowers cover every loan.
    for (const i of [1, 3, 4, 6]) expect(total(i, "net")).toBe(all.net);
    expect(total(6, "loans")).toBe(all.loans);
    expect(Number(all.net)).toBeGreaterThan(0);
    const conc = r.tables[5];
    const top5 = conc.rows.find((x) => x.label === "Top 5 together")!;
    expect(Number(top5.share)).toBeGreaterThan(0);
    expect(Number(top5.share)).toBeLessThanOrEqual(1);
    expect(conc.rows.slice(0, -1).reduce((s, x) => s + Number(x.owed), 0)).toBe(top5.owed);
    // Best and worst don't overlap.
    const names = (i: number) => r.tables[i].rows.map((x) => `${x.borrower}${x.opened}`);
    expect(names(8).filter((n) => names(9).includes(n))).toEqual([]);
  });

  it("portfolio health: what's at risk, week by week, vintages and expected losses agree", async () => {
    const r = await buildReport(ceo, "health", range);
    expect(r.tables.map((t) => t.title)).toEqual(["At risk now", "Week by week", "Movement over the last 12 weeks", "By month lent", "Expected losses", "Mortgages late or behind"]);
    const [atRisk, weeks, , vintages, losses] = r.tables;
    expect(atRisk.rows.reduce((s, x) => s + Number(x.owed), 0)).toBe(atRisk.total!.owed);
    expect(weeks.rows).toHaveLength(12);
    for (const w of weeks.rows) expect(Number(w.atRisk)).toBeLessThanOrEqual(1);
    expect(vintages.rows.reduce((s, x) => s + Number(x.loans), 0)).toBeGreaterThan(50);
    const buckets = losses.rows.slice(0, 3);
    expect(buckets.reduce((s, x) => s + Number(x.expected), 0)).toBe(losses.total!.expected);
    expect(losses.rows[3].owed).toBe(Number(losses.total!.owed) - Number(losses.total!.expected));
    for (const b of buckets) expect(Number(b.rate)).toBeLessThanOrEqual(1);
  });

  it("exports to Excel with one sheet per table and money in dollars", async () => {
    const r = await buildReport(ceo, "balance", range);
    const wb = XLSX.read(reportToXlsx(r), { type: "buffer" });
    expect(wb.SheetNames).toEqual(["What the company has", "What the company owes", "Owners' equity"]);
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets["What the company has"], { header: 1 });
    const cash = rows.find((x) => String(x[0]).startsWith("1000"))!;
    expect(cash[1]).toBe(185_331);
  });
});
