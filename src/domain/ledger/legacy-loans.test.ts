import { describe, expect, it } from "vitest";
import { groupLegacyLoans, type LegacyRow } from "./legacy-loans";

let seq = 0;
const row = (day: string, direction: "in" | "out", dollars: number, comment: string, wallet: string): LegacyRow => ({
  id: `r${++seq}`,
  occurredAt: new Date(`${day}T12:00:00Z`),
  direction,
  amountCents: dollars * 100,
  comment,
  sourceWallet: direction === "in" ? wallet : "69811362",
  targetWallet: direction === "out" ? wallet : "69811362",
});

describe("groupLegacyLoans", () => {
  const rows = [
    row("2025-01-27", "out", 1_500, "Employee Pay: $1500 Loan - 20% Interest - 4 Weeks - #1", "W1"),
    row("2025-02-20", "out", 7_500, "Employee Pay: $7500 Loan - 20% Interest - 4 Weeks - #2", "W2"),
    row("2025-02-27", "in", 2_318, "Charge: Loan #2 - Vale Draycott - Repayment 1", "W2"),
    row("2025-03-01", "in", 6_953, "Charge: Loan #2 - Vale Draycott - Full Repayment", "W2"),
    row("2025-03-14", "out", 50_000, "Employee Pay: Harper Quarles | $50,000 Loan | 20% Interest", "W3"),
    row("2025-03-24", "in", 60_000, "Charge: Loan #3 | Harper Quarles | Payment #1", "W3"),
    row("2025-04-01", "out", 5_000, "Employee Pay: Indie Axworthy | $5,000 Loan", "W4"),
    // Typo: says #3 but comes from Indie's wallet.
    row("2025-04-08", "in", 3_000, "Charge: Loan #3 | EARLY Payment #8", "W4"),
    // No number: Indie's wallet.
    row("2025-04-09", "in", 3_000, "Charge: Indie A. | Payment #2", "W4"),
    row("2025-05-01", "out", 10_000, "Employee Pay: MOTOR VEHICLE LOAN", "W5"),
    row("2025-05-08", "in", 11_000, "Charge Wren Last payment for loan", "OTHER"),
    row("2025-05-09", "in", 99, "Charge mystery", "OTHER"),
  ];

  it("numbers payouts in order, follows loan numbers, fixes typos by wallet, and fills gaps by wallet", () => {
    const { loans, unplaced } = groupLegacyLoans(rows, [{ pattern: /wren/i, loan: 5 }]);
    const result = Object.fromEntries(loans.map((l) => [l.number, l.resultCents / 100]));
    expect(result).toEqual({ 1: -1_500, 2: 1_771, 3: 10_000, 4: 1_000, 5: 1_000 });
    expect(loans.find((l) => l.number === 2)!.closedAt.toISOString().slice(0, 10)).toBe("2025-03-01");
    expect(loans.find((l) => l.number === 1)!.closedAt.toISOString().slice(0, 10)).toBe("2025-01-27");
    expect(unplaced.map((r) => r.comment)).toEqual(["Charge mystery"]);
  });

  it("fixes a typo'd number to the borrower's loan closest to it", () => {
    const hollis = [
      row("2025-08-05", "out", 48_000, "Employee Pay: Hollis | $48,000 Loan", "S"),
      row("2025-08-17", "out", 25_000, "Employee Pay: Avery | $25,000 Loan", "P"),
      row("2025-08-25", "out", 55_000, "Employee Pay: Hollis | $55,000 Loan", "S"),
      row("2025-08-31", "out", 10_000, "Employee Pay: Hollis | $10,000 Loan", "S"),
      row("2025-09-04", "in", 11_330, "Charge: Loan #2 | Payment #4", "S"), // #2 is Avery's; Hollis's closest is #3
    ];
    const { loans } = groupLegacyLoans(hollis);
    expect(loans.find((l) => l.number === 3)!.rows.map((r) => r.amountCents)).toEqual([5_500_000, 1_133_000]);
  });

  it("doesn't read a payment number as the loan number", () => {
    const { loans } = groupLegacyLoans([rows[0], rows[1], row("2025-03-02", "in", 100, "Charge: #2 | Payment #1", "W2")]);
    expect(loans.find((l) => l.number === 2)!.rows).toHaveLength(2);
  });
});
