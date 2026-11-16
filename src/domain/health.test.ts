import { describe, expect, it } from "vitest";
import { collectionRate, everBehind, rollMovement, sinceDefault, snapshot, stateAt, type HealthLoan } from "./health";

const DAY = 86_400_000;
const d0 = new Date("2026-06-01T12:00:00Z");
const day = (n: number) => new Date(d0.getTime() + n * DAY);
// $4,000 over 4 weekly instalments at 10%: $1,100 a week from the borrower.
const base: HealthLoan = { id: "a", openedAt: d0, principalCents: 400_000, instalments: 4, periodDays: 7, brokerRateBp: 1000, completedAt: null, firstDefaultAt: null, writtenOffAt: null, payments: [] };
const pay = (n: number) => ({ at: day(n), grossCents: 110_000, principalCents: 100_000 });

describe("stateAt", () => {
  it("follows the schedule, the bank and the default/complete dates", () => {
    const l = { ...base, payments: [pay(7), pay(14)] };
    expect(stateAt(l, day(-1))).toBeNull();
    expect(stateAt(l, day(8))).toBe("paying");
    expect(stateAt(l, day(21.5))).toBe("paying"); // a day's grace
    expect(stateAt(l, day(23))).toBe("behind");
    expect(stateAt({ ...l, firstDefaultAt: day(30) }, day(31))).toBe("defaulted");
    expect(stateAt({ ...l, firstDefaultAt: day(30), completedAt: day(40) }, day(41))).toBe("repaid");
    expect(stateAt({ ...l, firstDefaultAt: day(30), writtenOffAt: day(60) }, day(61))).toBe("written_off");
  });
  it("counts an early repayment as instalments paid", () => {
    expect(stateAt({ ...base, payments: [{ at: day(3), grossCents: 300_000, principalCents: 300_000 }] }, day(23))).toBe("paying");
  });
  it("uses the game's due dates: after a late payment the next falls due a period later (QA 2026-10-13)", () => {
    // The 2nd instalment paid two days late (day 16): the game wants the 3rd on day 23, not the contract's day 21.
    const l = { ...base, payments: [pay(7), pay(16)], instalmentsPaidAt: [day(7), day(16)] };
    expect(stateAt({ ...l, instalmentsPaidAt: undefined }, day(22.5))).toBe("behind"); // by the contract's dates
    expect(stateAt(l, day(22.5))).toBe("paying");
    expect(stateAt(l, day(24.5))).toBe("behind");
  });
});

describe("snapshot and movement", () => {
  const good = { ...base, payments: [pay(7), pay(14), pay(21), pay(28)], completedAt: day(28.5) };
  const late = { ...base, id: "b", payments: [pay(7)], firstDefaultAt: day(35) };
  it("shares out what's owed by state", () => {
    const s = snapshot([good, late], day(22.5));
    expect(s.count).toMatchObject({ paying: 1, behind: 1 });
    expect(s.owed).toEqual({ paying: 100_000, behind: 300_000, defaulted: 0 });
    expect(s.atRiskShare).toBe(0.75);
  });
  it("counts moves between moments", () => {
    const m = rollMovement([good, late], [day(13), day(30), day(36)]);
    expect(m.paying.repaid).toBe(1);
    expect(m.paying.behind).toBe(1); // day 13 the late one was still up to date
    expect(m.behind.defaulted).toBe(1);
  });
  it("compares collected with due", () => {
    const r = collectionRate([good, late], day(10), day(17));
    expect(r).toEqual({ dueCents: 220_000, collectedCents: 110_000, rate: 0.5 });
  });
});

describe("history for loss rates", () => {
  it("spots a loan that fell behind and caught up, and what a default got back", () => {
    const caughtUp = { ...base, payments: [pay(7), { ...pay(16), principalCents: 200_000, grossCents: 220_000 }, pay(28)], completedAt: day(28.5) };
    expect(everBehind(caughtUp, day(60))).toBe(true);
    expect(everBehind({ ...base, payments: [pay(7), pay(14), pay(21), pay(28)] }, day(60))).toBe(false);
    const bad = { ...base, payments: [pay(7), pay(40)], firstDefaultAt: day(30) };
    expect(sinceDefault(bad)).toEqual({ owedCents: 300_000, recoveredCents: 100_000 });
    expect(sinceDefault(base)).toBeNull();
  });
});
