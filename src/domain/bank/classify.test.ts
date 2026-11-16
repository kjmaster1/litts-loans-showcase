import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classify, COMMENT_TAGS, mortgageAddress } from "./classify";
import { parseBankExport } from "./parse-export";

const parsed = parseBankExport(readFileSync("tests/fixtures/bank-export.xlsx"));
const results = parsed.rows.map((r) => ({ row: r, c: classify(r) }));

function tally(filter: (x: (typeof results)[number]) => boolean) {
  const out: Record<string, number> = {};
  for (const x of results.filter(filter)) out[x.c.category] = (out[x.c.category] ?? 0) + 1;
  return out;
}

describe("classification of the anonymised export (golden)", () => {
  it("classifies all game-generated rows with certainty", () => {
    expect(tally((x) => x.c.confidence === "certain")).toEqual({
      "loan.disbursement": 85,
      "loan.early_interest": 129,
      "loan.early_principal": 99,
      "loan.interest": 384,
      "loan.late_principal": 23,
      "loan.origination_fee": 125,
      "loan.principal": 388,
      "mortgage.legacy_broker_interest": 193,
      "mortgage.origination_in": 27,
      "mortgage.origination_out": 27,
      "mortgage.repayment_in": 15,
      "mortgage.repayment_out": 15,
      "recovery.seizure": 2,
      "tax.remittance_record": 20,
    });
  });

  it("suggests categories for manual rows by keyword", () => {
    expect(tally((x) => x.c.confidence === "heuristic")).toEqual({
      "capital.contribution": 15,
      "capital.return": 11,
      collateral_sale: 7,
      collection_cost: 4,
      commission: 139,
      "legacy_loan.disbursement": 34,
      "legacy_loan.repayment": 123,
      legal: 13,
      "loan.late_fee": 1,
      marketing: 2,
      refund: 22,
      "staff_loan.received": 5,
      "staff_loan.repaid": 2,
      staff_pay: 5,
    });
  });

  it("sends only genuinely ambiguous rows to review", () => {
    const review = results.filter((x) => x.c.category === "unclassified").map((x) => x.row.comment.trim());
    expect(review.sort()).toEqual(
      [
        "Charge Cuz I think I lost us 1000 in a mortgage",
        "Charge Filler for loan to be given out",
        "Charge Investment or something - Ask Casey",
        "Charge Reese Whitlock loan pay off due to issues with default in banking system",
        "Employee Pay: Buffalo A/C Sport Sale Transfer",
        "Employee Pay: Loan #21 | Payment #1",
        "Transfer: Pride Golf",
      ].sort(),
    );
  });

  it("never assigns a category that contradicts the row's direction", () => {
    for (const { row, c } of results) {
      if (c.category === "unclassified") continue;
      expect(["in", "out"]).toContain(row.direction);
    }
  });

  it("extracts the address from every mortgage leg", () => {
    const legs = results.filter((x) => x.c.category.startsWith("mortgage.") && x.c.category !== "mortgage.legacy_broker_interest");
    expect(legs).toHaveLength(84);
    expect(legs.every((x) => x.c.address && x.c.address.length > 3)).toBe(true);
  });
});

describe("classify rules", () => {
  const base = { txType: "transfer", targetWallet: "69811362" } as const;

  it("lets game-generated wording win over a tag", () => {
    expect(classify({ ...base, direction: "in", comment: "Subscription payment Loan Agreement Amount: $500001/5" }).confidence).toBe("certain");
  });

  it("honours explicit comment tags by direction", () => {
    expect(classify({ ...base, txType: "charge", direction: "in", comment: "[REPO] Bison sold at auction" })).toMatchObject({ category: "collateral_sale", confidence: "tag" });
    expect(classify({ ...base, txType: "pay", direction: "out", comment: "Employee Pay: [STAFFLOAN] back to Sam" })).toMatchObject({ category: "staff_loan.repaid", confidence: "tag" });
    expect(classify({ ...base, txType: "charge", direction: "in", comment: "Charge: [staffloan] from Sam" })).toMatchObject({ category: "staff_loan.received", confidence: "tag" });
  });

  it("ignores a tag that doesn't fit the direction", () => {
    expect(classify({ ...base, txType: "pay", direction: "out", comment: "[CAPITAL] oops" }).category).toBe("unclassified");
  });

  it("documents a usable mapping for every tag", () => {
    for (const [tag, def] of Object.entries(COMMENT_TAGS)) {
      expect(def.in ?? def.out, tag).toBeTruthy();
      expect(def.description.length, tag).toBeGreaterThan(5);
    }
  });

  it("only treats 'Tax Payment' to the escrow wallet as the monthly record", () => {
    expect(classify({ txType: "deposit", direction: "out", comment: "Tax Payment", targetWallet: "69740396" }).category).toBe("tax.remittance_record");
    expect(classify({ txType: "deposit", direction: "out", comment: "Tax Payment", targetWallet: "12345678" }).category).toBe("unclassified");
  });

  it("files a mortgage's last instalment like any other", () => {
    const comment = "104 Forum Dr, Apt 1F: Final Loan Repayment";
    expect(classify({ ...base, direction: "in", comment })).toMatchObject({ category: "mortgage.repayment_in", confidence: "certain", address: "104 Forum Dr, Apt 1F" });
    expect(classify({ txType: "transfer", direction: "out", comment, targetWallet: "69794349" })).toMatchObject({ category: "mortgage.repayment_out", confidence: "certain", address: "104 Forum Dr, Apt 1F" });
    expect(mortgageAddress(comment)).toBe("104 Forum Dr, Apt 1F");
  });

  it("doesn't take other repayment wording for a mortgage instalment", () => {
    expect(classify({ ...base, direction: "in", comment: "Arlo: Personal Loan Repayment" }).category).toBe("staff_loan.received");
    expect(classify({ txType: "transfer", direction: "out", comment: "104 Forum Dr: Final Loan Repayment", targetWallet: "12345678" }).category).toBe("unclassified");
    expect(mortgageAddress("Arlo: Personal Loan Repayment")).toBeNull();
  });

  it("parses mortgage addresses", () => {
    expect(mortgageAddress("110 Spanish Ave, Apt 2A: Property Loan & Fees")).toBe("110 Spanish Ave, Apt 2A");
    expect(mortgageAddress("Loan Transfer abc")).toBeNull();
  });
});
