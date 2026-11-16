import { describe, expect, it } from "vitest";
import { percentOfCents, wholeDollars } from "./money";

describe("percentOfCents (exact, integer basis points)", () => {
  it("gets half-dollar cases right that decimal maths got wrong", () => {
    // 4.35% of $1,000 is exactly $43.50 → $44. In floating point 100000 × 4.35 is
    // 434,999.99999…, which the old wholeDollars(cents × pct / 100) rounded down to $43.
    expect(wholeDollars((100_000 * 4.35) / 100)).toBe(4_300);
    expect(percentOfCents(100_000, 4.35, "nearest")).toBe(4_400);
  });

  it("rounds up like the tablet, with no fudge factor", () => {
    expect(percentOfCents(68_938_600, 10, "up")).toBe(6_893_900); // $689,386 × 10% = $68,938.60 → $68,939
    expect(percentOfCents(62_044_700, 6, "up")).toBe(3_722_700); // $37,226.82 → $37,227
    expect(percentOfCents(10_000_000, 6.1, "up")).toBe(610_000); // exact: no float creep above $6,100
    expect(percentOfCents(0, 15, "up")).toBe(0);
  });

  it("rounds to the nearest dollar, half away from zero", () => {
    expect(percentOfCents(13_000_000, 15, "nearest")).toBe(1_950_000);
    expect(percentOfCents(1_000_100, 50, "nearest")).toBe(500_100); // $5,000.50 → $5,001
    expect(percentOfCents(-1_000_100, 50, "nearest")).toBe(-500_100);
  });
});
