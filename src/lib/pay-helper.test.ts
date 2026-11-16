import { describe, expect, it } from "vitest";
import { bookmarklet, PAY_LIST_KIND, phoneList } from "./pay-helper";

const rows = [
  { name: "Avery Lane", stateId: 40001, owedCents: 123_400, comment: "[COMM] Commission Pay: w/c 26 Oct" },
  { name: "Jax Chaplan", stateId: 515151, owedCents: 97_100, comment: "[COMM] Commission Pay: catch-up, w/c 12 Oct" },
];

describe("the list for the phone", () => {
  it("carries State ID, whole-dollar amount and comment per person", () => {
    const list = JSON.parse(phoneList(rows));
    expect(list.kind).toBe(PAY_LIST_KIND);
    expect(list.rows).toEqual([
      { name: "Avery Lane", stateId: 40001, amount: 1234, pay: "$1,234", comment: "[COMM] Commission Pay: w/c 26 Oct" },
      { name: "Jax Chaplan", stateId: 515151, amount: 971, pay: "$971", comment: "[COMM] Commission Pay: catch-up, w/c 12 Oct" },
    ]);
  });

  it("gets a new id when anything changes, so ticks from an older list don't apply", () => {
    const id = (r: typeof rows) => JSON.parse(phoneList(r)).id;
    expect(id(rows)).toBe(id(rows.map((r) => ({ ...r }))));
    expect(id(rows)).not.toBe(id([{ ...rows[0], owedCents: 123_500 }, rows[1]]));
    expect(id(rows)).not.toBe(id([rows[0]]));
  });
});

describe("the phone helper bookmark", () => {
  it("is a javascript: address holding a self-contained script", () => {
    const url = bookmarklet();
    expect(url.startsWith("javascript:")).toBe(true);
    const code = decodeURIComponent(url.slice("javascript:".length));
    // Parses on its own (it runs on the phone page, away from this module).
    expect(() => new Function(code)).not.toThrow();
    // No bundler helpers (esbuild's keepNames adds `__name(...)`) or module loading: none exist on the phone page.
    expect(code).not.toMatch(/(?<![.\w])__\w+\(|__turbopack|require\(|import\(/);
  });
});
