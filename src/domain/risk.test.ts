import { describe, expect, it } from "vitest";
import { expectedLoss, lossRates, type LoanHistory } from "./risk";

const h = (status: LoanHistory["status"], everOverdue = false, everDefaulted = status === "defaulted" || status === "written_off"): LoanHistory => ({ status, everOverdue, everDefaulted });

describe("lossRates", () => {
  const history = [
    ...Array.from({ length: 6 }, () => h("completed")),
    h("completed", true),
    h("completed", true),
    h("completed", true, true), // defaulted, then repaid
    h("defaulted", true),
    h("written_off", true),
    h("active"),
    h("overdue", true),
  ];

  it("works out each bucket from loans that reached an outcome", () => {
    const r = lossRates(history, { owedCents: 0, recoveredCents: 0 });
    expect(r.active).toMatchObject({ bad: 2, of: 11, borrowed: false });
    expect(r.active.rate).toBeCloseTo(2 / 11);
    expect(r.overdue).toMatchObject({ bad: 2, of: 5, borrowed: false }); // 3 ever overdue + repaid, 2 bad
    expect(r.defaulted).toMatchObject({ bad: 2, of: 3 }); // one of three came back
    expect(r.lossGivenDefault).toBe(1); // no bad debts on record: assume nothing comes back
  });

  it("lets a thin bucket borrow the rate before it", () => {
    const r = lossRates([h("completed"), h("defaulted"), h("active")], { owedCents: 0, recoveredCents: 0 });
    expect(r.active.borrowed).toBe(true);
    expect(r.overdue.rate).toBe(r.active.rate);
    expect(r.defaulted).toMatchObject({ rate: 1, borrowed: true });
  });

  it("reduces losses by what bad debts have paid back since defaulting", () => {
    const r = lossRates(history, { owedCents: 1_000_000, recoveredCents: 250_000 });
    expect(r.lossGivenDefault).toBe(0.75);
    expect(expectedLoss(1_000_000, "overdue", r)).toBe(Math.round(1_000_000 * 0.4 * 0.75));
    expect(expectedLoss(-5, "defaulted", r)).toBe(0);
  });
});
