import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { auditTarget, LABELLED_ACTIONS } from "./audit-labels";

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sources(p) : /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
  });
}

describe("audit labels", () => {
  it("has a readable label for every action the app records", () => {
    const recorded = new Set<string>();
    for (const file of [...sources("src"), ...sources("scripts")]) {
      for (const m of readFileSync(file, "utf8").matchAll(/action: (?:[^"\n]*\? )?"([a-z0-9_]+\.[a-z0-9_.]+)"(?: : "([a-z0-9_]+\.[a-z0-9_.]+)")?/g)) {
        recorded.add(m[1]);
        if (m[2]) recorded.add(m[2]);
      }
    }
    expect(recorded.size).toBeGreaterThan(40);
    expect([...recorded].filter((a) => !LABELLED_ACTIONS.has(a))).toEqual([]);
  });

  it("names and links subjects", () => {
    const id = "1d921ded-f0b0-4a9c-a641-24e31f02f354";
    expect(auditTarget("loan_offer", id, { number: 2 })).toEqual({ label: "Loan offer #2", href: `/loans/offers/${id}` });
    expect(auditTarget("mortgage_quote", id, { number: 1, address: "117 Invention Ct" })?.label).toBe("Mortgage quote #1 · 117 Invention Ct");
    expect(auditTarget("borrower", "15819", {})).toEqual({ label: "Borrower #15819", href: "/loans/borrowers/15819" });
    expect(auditTarget("list", "loans", {})?.label).toBe("List · loans");
    expect(auditTarget(null, null, {})).toBeNull();
  });
});
