import { describe, expect, it } from "vitest";
import { matchRecoveries, matchRefunds } from "./recovery";

const d = (iso: string) => new Date(iso);
const loans = [
  // Arlo's default date is a late estimate: with one bad loan, it doesn't matter.
  { id: "arlo", borrowerName: "Arlo Oswin", openedAt: d("2026-02-14"), firstDefaultAt: d("2026-08-31") },
  { id: "emma1", borrowerName: "Dakota Thornbury", openedAt: d("2026-03-30"), firstDefaultAt: d("2026-06-01") },
  { id: "emma2", borrowerName: "Dakota Thornbury", openedAt: d("2026-04-09"), firstDefaultAt: d("2026-06-08") },
  { id: "noname", borrowerName: null, openedAt: d("2025-12-01"), firstDefaultAt: d("2026-01-01") },
  { id: "mono", borrowerName: "Arlo", openedAt: d("2025-12-01"), firstDefaultAt: d("2026-01-01") },
];

describe("matchRecoveries", () => {
  it("links a payment that names one borrower with one defaulted loan", () => {
    const rows = [
      { id: "a", occurredAt: d("2026-04-19"), comment: "Charge Arlo Oswin Payment 1/6" },
      { id: "b", occurredAt: d("2026-05-16"), comment: "Charge arlo oswin week 4 minus commission pay" },
    ];
    expect(matchRecoveries(rows, loans)).toEqual([
      { txId: "a", loanId: "arlo" },
      { txId: "b", loanId: "arlo" },
    ]);
  });

  it("leaves anything ambiguous or too early for a person", () => {
    const rows = [
      { id: "two-loans", occurredAt: d("2026-07-01"), comment: "Charge Dakota Thornbury settlement" }, // both defaulted by then
      { id: "before", occurredAt: d("2026-02-01"), comment: "Charge Arlo Oswin early" }, // before her loan existed
      { id: "nobody", occurredAt: d("2026-07-01"), comment: "Charge Akuma Sale" },
      { id: "partial", occurredAt: d("2026-07-01"), comment: "Charge Arlo Oswins" },
    ];
    expect(matchRecoveries(rows, loans)).toEqual([]);
    // Once only one of Dakota's loans had defaulted, it's clear which.
    expect(matchRecoveries([{ id: "x", occurredAt: d("2026-06-03"), comment: "Dakota Thornbury paid" }], loans)).toEqual([{ txId: "x", loanId: "emma1" }]);
  });
});

describe("matchRefunds", () => {
  it("puts a refund on the borrower's latest loan opened before it, found by wallet", () => {
    const loans = [
      { id: "old", openedAt: d("2026-01-10"), wallets: ["W1"] },
      { id: "new", openedAt: d("2026-03-01"), wallets: ["W1", "W9"] },
      { id: "later", openedAt: d("2026-05-01"), wallets: ["W1"] },
      { id: "other", openedAt: d("2026-02-01"), wallets: ["W2"] },
    ];
    expect(
      matchRefunds(
        [
          { id: "r1", occurredAt: d("2026-03-23"), targetWallet: "W1" },
          { id: "r2", occurredAt: d("2026-03-23"), targetWallet: "W3" },
          { id: "r3", occurredAt: d("2026-03-23"), targetWallet: null },
        ],
        loans,
      ),
    ).toEqual([{ txId: "r1", loanId: "new" }]);
  });
});
