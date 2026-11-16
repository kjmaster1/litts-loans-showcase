import { describe, expect, it } from "vitest";
import { asStateId, cleanSearch, likeEscape } from "./search";

describe("search text", () => {
  it("drops control characters that Postgres can't store", () => {
    expect(cleanSearch("ab\u0000c\n ")).toBe("ab c");
    expect(cleanSearch(undefined)).toBe("");
    expect(cleanSearch("x".repeat(500))).toHaveLength(100);
  });
  it("only treats short numbers as State IDs", () => {
    expect(asStateId("15819")).toBe(15819);
    expect(asStateId("99999999999")).toBeNull();
    expect(asStateId("12a")).toBeNull();
  });
  it("escapes LIKE wildcards", () => {
    expect(likeEscape("50%_a\\")).toBe("50\\%\\_a\\\\");
  });
});
