import { describe, expect, it } from "vitest";
import { lendingFlags, trackRecord, type FinishedLoan } from "./lending";

const loan = (dollars: number, ratePct: number, bad: boolean, overlapped = false): FinishedLoan => ({ principalCents: dollars * 100, brokerRateBp: ratePct * 100, bad, overlapped });
// 6 small loans (3 bad), 6 large (none bad); 5 overlapping (1 bad).
const record = trackRecord([
  ...[true, true, true, false, false, false].map((b) => loan(10_000, 20, b)),
  ...[false, false, false, false, false, false].map((b, i) => loan(100_000, 12, b, i < 4)),
  loan(30_000, 15, true, true),
]);
const empty = { doNotLend: null, loans: [], mortgagesBehind: 0, isStaff: false };

describe("track record", () => {
  it("counts bad loans by size, rate and overlap", () => {
    expect(record.overall).toEqual({ label: "all loans", loans: 13, bad: 4 });
    expect(record.bySize.map((b) => [b.label, b.loans, b.bad])).toEqual([
      ["under $25,000", 6, 3],
      ["$25,000–$74,999", 1, 1],
      ["$75,000 or more", 6, 0],
    ]);
    expect(record.whileOpen).toMatchObject({ loans: 5, bad: 1 });
  });
});

describe("lendingFlags", () => {
  it("flags a do-not-lend mark, defaults, write-offs and a loan running now", () => {
    const flags = lendingFlags(
      {
        doNotLend: { reason: "Threatened staff", by: "Kieran Jones", at: new Date() },
        loans: [
          { status: "written_off", everDefaulted: true, outstandingCents: null },
          { status: "active", everDefaulted: false, outstandingCents: 1_500_000 },
        ],
        mortgagesBehind: 0,
        isStaff: false,
      },
      {},
      record,
    );
    expect(flags.map((f) => f.level)).toEqual(["danger", "danger", "warning"]);
    expect(flags[0].text).toBe("Marked do not lend by Kieran Jones: Threatened staff");
    expect(flags[2].text).toBe("Already has 1 loan running ($15,000 still owed); 1 of 5 loans made while another was running went bad (20%)");
  });

  it("warns from the company's own record for the size and rate asked for", () => {
    const flags = lendingFlags(empty, { amountCents: 800_000, rateBp: 2000 }, record);
    expect(flags).toEqual([
      { level: "warning", text: "Loans under $25,000: 3 of 6 went bad (50%; all loans 31%)" },
      { level: "warning", text: "Rates 20% or more: 3 of 6 went bad (50%)" },
      { level: "info", text: "First-time borrower: no history with Litt's" },
    ]);
    // Too few loans in a band to say anything.
    expect(lendingFlags(empty, { amountCents: 3_000_000 }, record).some((f) => f.text.startsWith("Loans $25,000"))).toBe(false);
  });

  it("says so when the history is clean", () => {
    const flags = lendingFlags({ ...empty, loans: [{ status: "completed", everDefaulted: false, outstandingCents: 0 }] }, { amountCents: 10_000_000 }, record);
    expect(flags).toEqual([
      { level: "info", text: "Loans $75,000 or more: 0 of 6 went bad (0%; all loans 31%)" },
      { level: "good", text: "Repaid 1 loan in full, never defaulted" },
    ]);
  });
});
