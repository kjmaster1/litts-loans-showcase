import { describe, expect, it } from "vitest";
import { classify } from "@/domain/bank/classify";
import { buildSheet, caseDefault, daysBetween, feeComment, feeReference, londonDay, ordinalDate, sheetText } from "./case-sheet";

const AUG_6 = new Date("2026-08-06T15:00:00Z");

describe("the owner's examples (slips in the last line corrected)", () => {
  it("Rowan Redgrave, handed over 6 Aug", () => {
    const s = buildSheet({
      borrowerName: "Rowan Redgrave",
      stateId: 6661,
      instalmentCents: 804_700,
      instalments: 6,
      completed: 1,
      feePerDayCents: 20_000,
      defaultAt: new Date("2026-07-21T03:07:01Z"),
      asOf: AUG_6,
      receivedCents: 0,
      collateral: "Ocelot Jackal - G1YBEU4B",
    });
    expect(s).toMatchObject({ instalmentsLeft: 5, claimCents: 4_023_500, days: 16, feeTotalCents: 320_000, totalCents: 4_343_500, defaultedOn: "2026-07-21" });
    expect(sheetText(s)).toBe(
      "Rowan Redgrave - 6661\n\n$8,047 * 5 = 40,235\n\n$200 per day in default\n\nDefaulted - July 21st 2026\n\n200 * 16 = $3,200\n\n40,235 + 3,200 = $43,435\n\nCollateral - Ocelot Jackal - G1YBEU4B",
    );
  });

  it("Hollis Vance, handed over 6 Aug", () => {
    const s = buildSheet({
      borrowerName: "Hollis Vance",
      stateId: 24317,
      instalmentCents: 1_082_600,
      instalments: 6,
      completed: 3,
      feePerDayCents: 10_000,
      defaultAt: new Date("2026-07-22T14:07:01Z"),
      asOf: AUG_6,
      receivedCents: 0,
      collateral: "Karin Mojave - R1FMA325",
    });
    expect(sheetText(s)).toBe(
      "Hollis Vance - 24317\n\n$10,826 * 3 = 32,478\n\n$100 per day in default\n\nDefaulted - July 22nd 2026\n\n100 * 15 = $1,500\n\n32,478 + 1,500 = $33,978\n\nCollateral - Karin Mojave - R1FMA325",
    );
  });
});

describe("default date", () => {
  it("hand-moved default uses the second missed payment (Zion Merriweather: first missed 29 Sep → 6 Oct)", () => {
    expect(
      caseDefault({ firstDefaultAt: new Date("2026-10-09T20:02:18Z"), firstMissedAt: new Date("2026-09-29T11:58:02Z"), missedPayments: 2, periodDays: null, override: null }),
    ).toEqual({ at: new Date("2026-10-06T11:58:02Z"), rule: "hand_moved" });
  });

  it("a game default keeps the stored default date", () => {
    const stored = new Date("2026-07-21T03:07:01Z");
    expect(caseDefault({ firstDefaultAt: stored, firstMissedAt: new Date("2026-07-07T03:07:01Z"), missedPayments: 3, periodDays: null, override: null })).toEqual({ at: stored, rule: "game" });
  });

  it("a date set by hand wins; nothing known gives null", () => {
    const override = new Date("2026-10-07T12:00:00Z");
    expect(caseDefault({ firstDefaultAt: new Date("2026-10-09T20:02:18Z"), firstMissedAt: null, missedPayments: 2, periodDays: 7, override })).toEqual({ at: override, rule: "override" });
    expect(caseDefault({ firstDefaultAt: null, firstMissedAt: null, missedPayments: null, periodDays: null, override: null })).toEqual({ at: null, rule: "game" });
  });

  it("a hand-moved loan whose card has no first missed date isn't guessed (review I1)", () => {
    // first_default_at would be the paste time: the date must be set by hand before the case is ready.
    expect(caseDefault({ firstDefaultAt: new Date("2026-10-09T20:02:18Z"), firstMissedAt: null, missedPayments: 2, periodDays: 7, override: null })).toEqual({
      at: new Date("2026-10-09T20:02:18Z"),
      rule: "unconfirmed",
    });
  });

  it("uses the London calendar: 23:30 UTC on 21 Jul (BST) is 22 Jul", () => {
    expect(londonDay(new Date("2026-07-21T23:30:00Z"))).toBe("2026-07-22");
    expect(londonDay(new Date("2026-12-21T23:30:00Z"))).toBe("2026-12-21");
    expect(daysBetween("2026-07-21", "2026-08-06")).toBe(16);
    expect(daysBetween("2026-10-24", "2026-10-26")).toBe(2); // across the clocks going back
  });

  it("writes ordinal dates", () => {
    const day = (d: number) => ordinalDate(`2026-01-${String(d).padStart(2, "0")}`);
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31].map(day)).toEqual([
      "January 1st 2026",
      "January 2nd 2026",
      "January 3rd 2026",
      "January 4th 2026",
      "January 11th 2026",
      "January 12th 2026",
      "January 13th 2026",
      "January 21st 2026",
      "January 22nd 2026",
      "January 23rd 2026",
      "January 31st 2026",
    ]);
    expect(ordinalDate("2026-09-05")).toBe("September 5th 2026");
  });
});

describe("money received since the default", () => {
  it("adds a line and subtracts it", () => {
    const s = buildSheet({
      borrowerName: "Rowan Redgrave",
      stateId: 6661,
      instalmentCents: 804_700,
      instalments: 6,
      completed: 1,
      feePerDayCents: 20_000,
      defaultAt: new Date("2026-07-21T03:07:01Z"),
      asOf: AUG_6,
      receivedCents: 500_000,
      collateral: "None (unsecured)",
    });
    expect(s.totalCents).toBe(3_843_500);
    expect(sheetText(s)).toBe(
      "Rowan Redgrave - 6661\n\n$8,047 * 5 = 40,235\n\n$200 per day in default\n\nDefaulted - July 21st 2026\n\n200 * 16 = $3,200\n\n$5,000 received since default\n\n40,235 + 3,200 - 5,000 = $38,435\n\nCollateral - None (unsecured)",
    );
  });

  it("never counts negative days or fewer than zero instalments", () => {
    const s = buildSheet({
      borrowerName: "A B",
      stateId: 1,
      instalmentCents: 100_000,
      instalments: 4,
      completed: 6,
      feePerDayCents: 5_000,
      defaultAt: new Date("2026-08-10T00:00:00Z"),
      asOf: AUG_6,
      receivedCents: 0,
      collateral: "x",
    });
    expect(s.instalmentsLeft).toBe(0);
    expect(s.days).toBe(0);
  });
});

describe("attorney & filing fee comment", () => {
  it("carries the case reference, which reads back from the bank comment", () => {
    expect(feeComment("Rowan Redgrave", 12)).toBe("[LEGAL] Attorney & Filing Fee - Rowan Redgrave Default #LC12");
    expect(feeReference("Employee Pay: Attorney & Filing Fee - Rowan Redgrave Default #LC12")).toBe(12);
    expect(feeReference("Employee Pay: Attorney & Filing Fee - x #lc7.")).toBe(7);
    expect(feeReference("Employee Pay: Attorney & Filing Fee")).toBeNull();
    expect(feeReference("Payment #LC12x")).toBeNull();
  });
});

describe("the fee comment is filed as a legal fee whatever the borrower is called", () => {
  it("is tagged [LEGAL], so a name like Bonus, Commission or Investment can't send it elsewhere", () => {
    for (const name of ["Bonus Smith", "Frankie Commission", "Investment Banks", "Ask Morgan"]) {
      const c = classify({ direction: "out", txType: "pay", comment: `Employee Pay: ${feeComment(name, 3)}`, targetWallet: "69683223" });
      expect(c.category, name).toBe("legal");
    }
  });
});
