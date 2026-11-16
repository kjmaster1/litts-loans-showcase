import { describe, expect, it } from "vitest";
import { monthPeriod, tzOffsetMinutes, zonedMidnight } from "./company-time";

describe("company time (Europe/London)", () => {
  it("knows BST and GMT offsets", () => {
    expect(tzOffsetMinutes(new Date("2026-07-01T12:00:00Z"))).toBe(60);
    expect(tzOffsetMinutes(new Date("2026-12-01T12:00:00Z"))).toBe(0);
  });

  it("puts local midnight at the right UTC instant", () => {
    expect(zonedMidnight(2026, 10, 1).toISOString()).toBe("2026-09-30T23:00:00.000Z"); // BST
    expect(zonedMidnight(2026, 12, 1).toISOString()).toBe("2026-12-01T00:00:00.000Z"); // GMT
  });

  it("handles the month containing the clocks going back", () => {
    // UK clocks go back on Sunday 25 Oct 2026; November starts in GMT.
    const oct = monthPeriod(2026, 10);
    expect(oct.from.toISOString()).toBe("2026-09-30T23:00:00.000Z");
    expect(oct.to.toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });

  it("handles December → January", () => {
    const dec = monthPeriod(2026, 12);
    expect(dec.to.toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(dec.label).toBe("December 2026");
  });
});

describe("reporting periods", () => {
  it("stay inside PostgreSQL's timestamptz range (year < 10000)", async () => {
    const { reportingPeriods } = await import("./company-time");
    for (const p of reportingPeriods(new Date("2026-10-09T12:00:00Z"))) {
      expect(p.from.getUTCFullYear()).toBeGreaterThanOrEqual(1970);
      expect(p.to.getUTCFullYear()).toBeLessThan(10000);
      expect(p.from.getTime()).toBeLessThan(p.to.getTime());
    }
  });
});
