import { describe, expect, it } from "vitest";
import { shorten } from "./long-text";

describe("shorten", () => {
  it("leaves short text alone and cuts long text at a whole character", () => {
    expect(shorten("Called at the bank", 400)).toBe("Called at the bank");
    expect(shorten("abc def", 4)).toBe("abc…");
    // Slicing UTF-16 units would split the emoji and leave a broken character.
    expect(shorten("ok 😀😀😀", 4)).toBe("ok 😀…");
  });
});
