import { describe, expect, it } from "vitest";
import { borrowerDirectory, filterDirectory, sortDirectory, type DirectoryLoan, type DirectoryMortgage } from "./directory";

const d = (s: string) => new Date(`${s}T12:00:00Z`);
const loan = (o: Partial<DirectoryLoan> & Pick<DirectoryLoan, "borrowerStateId" | "status">): DirectoryLoan => ({
  borrowerName: null,
  principalCents: 1_000_000,
  outstandingCents: 0,
  openedAt: d("2026-09-01"),
  lastPaymentAt: null,
  ...o,
});
const mortgage = (o: Partial<DirectoryMortgage>): DirectoryMortgage => ({ buyerStateId: 1, buyerName: null, status: "active", late: false, originatedAt: d("2026-08-01"), ...o });

describe("borrower directory", () => {
  const rows = borrowerDirectory(
    [
      loan({ borrowerStateId: 1, borrowerName: "Avery Lane", status: "completed" }),
      loan({ borrowerStateId: 1, status: "active", outstandingCents: 500_000, lastPaymentAt: d("2026-10-08") }),
      loan({ borrowerStateId: 2, borrowerName: "Blake Hart", status: "defaulted", outstandingCents: 2_000_000 }),
      loan({ borrowerStateId: 2, status: "written_off", outstandingCents: 900_000 }),
      loan({ borrowerStateId: 3, borrowerName: "Casey Moor", status: "completed" }),
    ],
    [mortgage({ buyerStateId: 4, buyerName: "Dana Reed", late: true }), mortgage({ buyerStateId: 1 }), mortgage({ buyerStateId: null })],
    new Set([3]),
  );
  const by = (id: number) => rows.find((r) => r.stateId === id)!;

  it("adds up each person's loans and mortgages", () => {
    expect(by(1)).toMatchObject({ name: "Avery Lane", loans: 2, openLoans: 1, mortgages: 1, openMortgages: 1, owedCents: 500_000, repaid: 1, wentBad: 0, standing: "active" });
    expect(by(1).lastActivityAt).toEqual(d("2026-10-08"));
    // Written-off balances aren't counted as owed.
    expect(by(2)).toMatchObject({ owedCents: 2_000_000, wentBad: 2, standing: "defaulted" });
    expect(by(3).standing).toBe("do_not_lend");
    expect(by(4).standing).toBe("late_mortgage");
    expect(rows).toHaveLength(4);
  });

  it("sorts and filters", () => {
    expect(sortDirectory(rows, "standing").map((r) => r.stateId)).toEqual([3, 2, 4, 1]);
    expect(sortDirectory(rows, "owed")[0].stateId).toBe(2);
    expect(sortDirectory(rows, "name").map((r) => r.name)).toEqual(["Avery Lane", "Blake Hart", "Casey Moor", "Dana Reed"]);
    expect(filterDirectory(rows, "hart").map((r) => r.stateId)).toEqual([2]);
    expect(filterDirectory(rows, "4").map((r) => r.stateId)).toEqual([4]);
  });
});
