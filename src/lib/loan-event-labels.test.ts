import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOAN_EVENT_LABEL } from "./loan-event-labels";

/** Every loan event the server writes has a label in the loan's history (review 2026-11-10: two showed raw keys). */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sources(p) : p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : [];
  });
}

describe("loan history labels", () => {
  it("cover every loan event kind the server writes", () => {
    const kinds = new Set<string>();
    for (const file of sources("src/server")) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/insert\(loanEvent\)\s*\.values\(\{[^}]*?kind: "([a-z_]+)"/g)) kinds.add(m[1]);
    }
    expect(kinds.size).toBeGreaterThan(10);
    expect([...kinds].filter((k) => !Object.hasOwn(LOAN_EVENT_LABEL, k))).toEqual([]);
  });
});
