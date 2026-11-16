import { describe, expect, it } from "vitest";
import { formatBp, formatCents, formatCount, formatDollars } from "./format";

describe("text formatting", () => {
  it("formats money one way everywhere", () => {
    expect(formatCents(14_950_000)).toBe("$149,500");
    expect(formatCents(123_456)).toBe("$1,234.56");
    expect(formatCents(-500_000)).toBe("−$5,000");
    expect(formatDollars(623_349)).toBe("$6,233"); // rounded like the game
  });
  it("counts and percentages", () => {
    expect(formatCount(1_936)).toBe("1,936");
    expect(formatCount(BigInt(12_345))).toBe("12,345");
    expect(formatBp(1500)).toBe("15%");
    expect(formatBp(650)).toBe("6.5%");
    expect(formatBp(1234)).toBe("12.34%");
  });
});
