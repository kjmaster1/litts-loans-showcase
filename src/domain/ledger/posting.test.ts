import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classify } from "@/domain/bank/classify";
import { parseBankExport } from "@/domain/bank/parse-export";
import { CATEGORIES, type Category } from "./categories";
import { isBalanced, postingLines, reverseLines, type Line } from "./posting";
import { pairMortgageLegs, settlementLines } from "./settlement";

const parsed = parseBankExport(readFileSync("tests/fixtures/bank-export.xlsx"));
const classified = parsed.rows.map((row, i) => ({ id: String(i), row, c: classify(row) }));

function balances(entries: Line[][]) {
  const b = new Map<string, number>();
  for (const lines of entries) for (const l of lines) b.set(l.account, (b.get(l.account) ?? 0) + l.debit - l.credit);
  return b;
}

describe("posting the whole anonymised export", () => {
  const postings = classified.map(({ row, c }) => postingLines({ ...row, category: c.category }));
  const legs = classified
    .filter(({ c }) => c.address)
    .map(({ id, row, c }) => ({ id, category: c.category, address: c.address!, occurredAt: row.occurredAt, amountCents: row.amountCents, taxCents: row.taxCents }));
  const pairs = pairMortgageLegs(legs);
  const settlements = pairs.map(settlementLines).filter((l) => l.length > 0);
  const all = [...postings, ...settlements];
  const bal = balances(all);

  it("produces only balanced entries", () => {
    expect(all.every(isBalanced)).toBe(true);
  });

  it("reconciles cash to the export's reported balance — $185,331", () => {
    expect(bal.get("1000")).toBe(parsed.reportedBalanceCents);
    expect(bal.get("1000")).toBe(18_533_100);
  });

  it("keeps the whole ledger in balance", () => {
    expect([...bal.values()].reduce((s, v) => s + v, 0)).toBe(0);
  });

  it("pairs every mortgage leg", () => {
    expect(legs).toHaveLength(84); // 27 + 27 origination, 15 + 15 repayment
    expect(pairs.filter((p) => p.kind === "origination")).toHaveLength(27);
    expect(pairs.filter((p) => p.kind === "repayment")).toHaveLength(15);
  });

  it("recognises the 117 Invention Ct broker fee shown on the tablet ($55,151)", () => {
    const p = pairs.find((x) => x.kind === "origination" && x.address === "117 Invention Ct")!;
    expect(p.residualCents).toBe(5_515_100);
  });

  it("recognises broker interest on mortgage instalments (105 South Rockford Dr: $588)", () => {
    const p = pairs.find((x) => x.kind === "repayment" && x.address === "105 South Rockford Dr")!;
    expect(p.residualCents).toBe(58_800);
  });

  it("empties mortgage clearing once every leg is paired", () => {
    expect(bal.get("1110") ?? 0).toBe(0);
  });

  it("nets the tax memo to tax withheld minus monthly records", () => {
    // Withheld from money coming in; the one taxed payment going out (a $3,500 flyer invoice) was the recipient's tax.
    const withheld = parsed.rows.filter((r) => r.direction === "in").reduce((s, r) => s + r.taxCents, 0);
    expect(parsed.rows.some((r) => r.direction === "out" && r.taxCents > 0)).toBe(true);
    const recorded = classified.filter((x) => x.c.category === "tax.remittance_record").reduce((s, x) => s + x.row.amountCents, 0);
    expect(bal.get("9000")).toBe(withheld - recorded);
    expect((bal.get("9000") ?? 0) + (bal.get("9090") ?? 0)).toBe(0);
  });
});

describe("postingLines", () => {
  it("books company-borne tax as an expense on lending income", () => {
    expect(postingLines({ direction: "in", amountCents: 9900_00, taxCents: 288_00, category: "loan.principal" })).toEqual([
      { account: "1000", debit: 9612_00, credit: 0, memo: undefined },
      { account: "5200", debit: 288_00, credit: 0, memo: "Tax withheld at source" },
      { account: "1100", debit: 0, credit: 9900_00, memo: undefined },
      { account: "9000", debit: 288_00, credit: 0, memo: "Tax withheld (memo)" },
      { account: "9090", debit: 0, credit: 288_00, memo: "Tax withheld (memo)" },
    ]);
  });

  it("leaves tax on a payment going out out of the company's tax memo (the recipient's tax)", () => {
    expect(postingLines({ direction: "out", amountCents: 3_500_00, taxCents: 167_00, category: "marketing" })).toEqual([
      { account: "5500", debit: 3_500_00, credit: 0, memo: undefined },
      { account: "1000", debit: 0, credit: 3_500_00, memo: undefined },
    ]);
  });

  it("treats mortgage tax as the buyer's pass-through, not company expense", () => {
    const lines = postingLines({ direction: "in", amountCents: 203_030_00, taxCents: 34_470_00, category: "mortgage.origination_in" });
    expect(lines.find((l) => l.account === "5200")).toBeUndefined();
    expect(lines.find((l) => l.account === "1110")?.credit).toBe(168_560_00);
  });

  it("never touches cash for the monthly tax record", () => {
    const lines = postingLines({ direction: "out", amountCents: 406_995_00, taxCents: 0, category: "tax.remittance_record" });
    expect(lines.some((l) => l.account === "1000")).toBe(false);
  });

  it("reversal lines cancel the original", () => {
    for (const category of Object.keys(CATEGORIES) as Category[]) {
      const direction = CATEGORIES[category].direction === "out" ? "out" : "in";
      const lines = postingLines({ direction, amountCents: 1000_00, taxCents: direction === "in" ? 30_00 : 0, category });
      const net = balances([lines, reverseLines(lines)]);
      expect([...net.values()].every((v) => v === 0), category).toBe(true);
    }
  });
});
