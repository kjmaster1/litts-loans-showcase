import { describe, expect, it } from "vitest";
import { dateFormat, shortMonths } from "./dates";

describe("short months", () => {
  it("says Sep, not Sept", () => {
    expect(shortMonths("30 Sept 2026")).toBe("30 Sep 2026");
    expect(shortMonths("September")).toBe("September");
    expect(dateFormat({ day: "numeric", month: "short", timeZone: "UTC" }).format(Date.UTC(2026, 8, 30))).toBe("30 Sep");
  });
});
