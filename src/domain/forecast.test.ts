import { describe, expect, it } from "vitest";
import { forecastByWeek, loanInflows, remainingPrincipal } from "./forecast";

const $ = (d: number) => d * 100;

describe("remainingPrincipal", () => {
  it("follows the schedule when the books agree with the phone", () => {
    // $40,000 over 8 → $5,000 each; 3 paid; $25,000 owed.
    expect(remainingPrincipal({ principalCents: $(40_000), instalments: 8, completed: 3, outstandingCents: $(25_000) })).toEqual([$(5_000), $(5_000), $(5_000), $(5_000), $(5_000)]);
  });
  it("puts money owed beyond the schedule (missed payments) on the next instalment", () => {
    // The card says 3 of 8 paid but the books say $30,000 is still owed.
    expect(remainingPrincipal({ principalCents: $(40_000), instalments: 8, completed: 3, outstandingCents: $(30_000) })).toEqual([$(10_000), $(5_000), $(5_000), $(5_000), $(5_000)]);
  });
  it("shrinks every remaining instalment in proportion when the borrower paid early (as the game does)", () => {
    // The card still says 5 of 6 paid, but only $1 is left (repaid early).
    expect(remainingPrincipal({ principalCents: $(40_000), instalments: 6, completed: 5, outstandingCents: $(1) })).toEqual([$(1)]);
    // $60,000 over 12, nothing paid on schedule yet, $55,140 owed after an early payment: each 0.919 of $5,000.
    expect(remainingPrincipal({ principalCents: $(60_000), instalments: 12, completed: 0, outstandingCents: $(55_140) })).toEqual([...Array(11).fill($(4_595)), $(4_595)]);
    // 0 of 6 paid per the card, $46,877 owed of $56,000.
    const parts = remainingPrincipal({ principalCents: $(56_000), instalments: 6, completed: 0, outstandingCents: $(46_877) });
    expect(parts.reduce((s, p) => s + p, 0)).toBe($(46_877));
    expect(parts).toHaveLength(6);
  });
  it("is nothing when nothing is owed, and one lump when the terms are unknown", () => {
    expect(remainingPrincipal({ principalCents: $(10_000), instalments: 4, completed: 4, outstandingCents: 0 })).toEqual([]);
    expect(remainingPrincipal({ principalCents: $(10_000), instalments: null, completed: null, outstandingCents: $(7_000) })).toEqual([$(7_000)]);
  });
});

describe("loanInflows", () => {
  const loan = {
    principalCents: $(20_000),
    instalments: 4,
    periodDays: 7,
    brokerRateBp: 2000,
    stateRateBp: 100,
    openedAt: new Date("2026-09-29T12:00:00Z"),
    completed: 1,
    nextPaymentDueAt: new Date("2026-10-13T12:00:00Z"),
    outstandingCents: $(15_000),
  };
  it("is the remaining instalments, less the State's share, plus interest, from the phone's next payment", () => {
    // Each: $5,000 principal − $50 State + $1,000 interest = $5,950 — except the final
    // instalment, which the game never charges interest on (game quirk): $4,950.
    expect(loanInflows(loan).map((f) => [f.at.toISOString().slice(0, 10), f.cents])).toEqual([
      ["2026-10-13", $(5_950)],
      ["2026-10-20", $(5_950)],
      ["2026-10-27", $(4_950)],
    ]);
  });
  it("adds up to what the books say is owed (net of the State) plus interest on it", () => {
    const flows = loanInflows({ ...loan, outstandingCents: $(12_000) });
    expect(flows.reduce((s, f) => s + f.principalCents, 0)).toBe($(12_000));
    expect(flows.reduce((s, f) => s + f.stateShareCents, 0)).toBe($(120));
    // Paid $3,000 early: three instalments of $4,000 (the game scales them); interest on all but the last.
    expect(flows.map((f) => f.principalCents)).toEqual([$(4_000), $(4_000), $(4_000)]);
    expect(flows.reduce((s, f) => s + f.interestCents, 0)).toBe($(1_600));
  });
});

describe("the final instalment's interest (game quirk)", () => {
  it("is only dropped when the remaining payments run to the last instalment", () => {
    const base = { principalCents: $(20_000), instalments: 4, periodDays: 7, brokerRateBp: 2000, stateRateBp: 0, openedAt: null, completed: 0, nextPaymentDueAt: new Date("2026-10-13T12:00:00Z") };
    expect(loanInflows({ ...base, outstandingCents: $(20_000) }).map((f) => f.interestCents)).toEqual([$(1_000), $(1_000), $(1_000), 0]);
    // Terms unknown: one lump, interest as usual.
    expect(loanInflows({ ...base, instalments: null, outstandingCents: $(5_000) }).map((f) => f.interestCents)).toEqual([$(1_000)]);
  });
});

describe("forecastByWeek", () => {
  it("buckets by London week, with what's overdue and what's later", () => {
    const now = new Date("2026-10-14T12:00:00Z"); // week of Mon 12 Oct
    const f = forecastByWeek(
      [
        { at: new Date("2026-10-05T12:00:00Z"), cents: 100, source: "loans" },
        { at: new Date("2026-10-15T12:00:00Z"), cents: 200, source: "loans" },
        { at: new Date("2026-10-18T22:30:00Z"), cents: 300, source: "mortgages" }, // Sun 23:30 BST — still that week
        { at: new Date("2026-10-19T12:00:00Z"), cents: 400, source: "mortgages" },
        { at: new Date("2027-03-01T12:00:00Z"), cents: 500, source: "loans" },
      ],
      now,
      2,
    );
    expect(f.overdue).toMatchObject({ totalCents: 100 });
    expect(f.weeks.map((w) => [w.key, w.loansCents, w.mortgagesCents])).toEqual([
      ["2026-10-12", 200, 300],
      ["2026-10-19", 0, 400],
    ]);
    expect(f.later).toMatchObject({ totalCents: 500 });
    expect(f.totalCents).toBe(1500);
  });
});
