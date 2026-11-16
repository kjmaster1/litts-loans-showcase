import { describe, expect, it } from "vitest";
import { defaultedAtEstimate, estimateDefaultedAt, nextDueFrom, staleRepaste, statusFromCard, writeOffEligibleAt } from "./status";

describe("statusFromCard", () => {
  it.each([
    [null, "active", "active"],
    // A missed payment shown on an Active-tab card doesn't make it overdue — the tab decides.
    ["active", "active", "active"],
    ["overdue", "active", "active"],
    ["active", "overdue", "overdue"],
    ["overdue", "default", "defaulted"],
    ["defaulted", "complete", "completed"],
    ["written_off", "complete", "written_off"],
    ["written_off", "active", "written_off"],
  ] as const)("%s seen in %s tab → %s", (current, tab, expected) => {
    expect(statusFromCard(current, tab)).toBe(expected);
  });
});

describe("dates", () => {
  it("estimates default as two periods after the first miss", () => {
    expect(defaultedAtEstimate(new Date("2026-04-09T16:44:25Z"), 7, new Date()).toISOString()).toBe("2026-04-23T16:44:25.000Z");
  });

  it("makes a write-off available 28 days after default", () => {
    expect(writeOffEligibleAt(new Date("2026-04-23T00:00:00Z")).toISOString()).toBe("2026-05-21T00:00:00.000Z");
  });

  it("turns 'Next payment: in 2 hours' into a time", () => {
    expect(nextDueFrom({ nextPaymentIn: { value: 2, unit: "hours" } }, new Date("2026-10-09T10:00:00Z"))?.toISOString()).toBe("2026-10-09T12:00:00.000Z");
    expect(nextDueFrom({ nextPaymentIn: null }, new Date())).toBeNull();
  });
});

describe("estimateDefaultedAt", () => {
  const now = new Date("2026-10-09T19:21:55Z");
  it("uses the card's first missed payment when it has one", () => {
    expect(estimateDefaultedAt({ firstMissedAt: new Date("2026-04-09T16:44:25Z"), periodDays: 7, lastPaidAt: null, openedAt: null, now }).toISOString()).toBe(
      "2026-04-23T16:44:25.000Z",
    );
  });
  it("counts three missed weeks from the start when nothing was ever paid (old-version card, no date)", () => {
    // Opened 14 Feb 2026, never paid: missed 21 Feb, 28 Feb, 7 Mar → defaulted 7 Mar.
    expect(estimateDefaultedAt({ firstMissedAt: null, periodDays: null, lastPaidAt: null, openedAt: new Date("2026-02-14T08:14:03Z"), now }).toISOString()).toBe(
      "2026-03-07T08:14:03.000Z",
    );
  });
  it("counts from the last payment, and never beyond now", () => {
    expect(estimateDefaultedAt({ firstMissedAt: null, periodDays: 7, lastPaidAt: new Date("2026-09-01T00:00:00Z"), openedAt: null, now }).toISOString()).toBe(
      "2026-09-22T00:00:00.000Z",
    );
    expect(estimateDefaultedAt({ firstMissedAt: null, periodDays: 7, lastPaidAt: new Date("2026-10-08T00:00:00Z"), openedAt: null, now })).toEqual(now);
  });
});

describe("staleRepaste", () => {
  const card = (raw: string, hours: number | null) => ({ raw, nextPaymentIn: hours === null ? null : { value: hours, unit: "hours" as const } });
  const before = { capturedAt: new Date("2026-10-13T00:38:18Z"), raws: ["A in 23 hours", "B in 22 hours"] };

  it("spots the same text pasted again once its countdowns should have moved", () => {
    const cards = [card("A in 23 hours", 23), card("B in 22 hours", 22)];
    expect(staleRepaste(cards, before, new Date("2026-10-13T02:23:46Z"))).toEqual(before.capturedAt);
    // Within the hour the phone may genuinely still say the same.
    expect(staleRepaste(cards, before, new Date("2026-10-13T01:20:00Z"))).toBeNull();
  });

  it("ignores changed text, and tabs with no countdowns (a Default tab can stay the same for weeks)", () => {
    expect(staleRepaste([card("A in 21 hours", 21), card("B in 22 hours", 22)], before, new Date("2026-10-13T02:23:46Z"))).toBeNull();
    expect(staleRepaste([card("X", null)], { capturedAt: before.capturedAt, raws: ["X"] }, new Date("2026-10-20T00:00:00Z"))).toBeNull();
    expect(staleRepaste([card("A in 23 hours", 23)], null, new Date())).toBeNull();
  });
});
