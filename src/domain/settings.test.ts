import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, resolveSettings, SETTING_LABELS, settingsChanges } from "./settings";

describe("allowance cushion setting", () => {
  it("defaults to $100,000", () => {
    expect(resolveSettings({}).mortgages.allowanceCushionDollars).toBe(100_000);
  });

  it("fills it in for an older stored version without the key", () => {
    const older: Partial<typeof DEFAULT_SETTINGS.mortgages> = { ...DEFAULT_SETTINGS.mortgages };
    delete older.allowanceCushionDollars;
    expect(resolveSettings({ mortgages: older }).mortgages.allowanceCushionDollars).toBe(100_000);
  });

  it("keeps a stored value and has a label", () => {
    const stored = { mortgages: { ...DEFAULT_SETTINGS.mortgages, allowanceCushionDollars: 250_000 } };
    expect(resolveSettings(stored).mortgages.allowanceCushionDollars).toBe(250_000);
    expect(SETTING_LABELS["mortgages.allowanceCushionDollars"]).toBe("State allowance: cushion before a quote counts as Tight ($)");
  });
});

describe("legal settings", () => {
  it("defaults the attorney & filing fee to $2,750 per case", () => {
    expect(DEFAULT_SETTINGS.legal.caseFeeDollars).toBe(2750);
    expect(resolveSettings({}).legal.caseFeeDollars).toBe(2750);
  });

  it("fills in the legal group for a version saved before it existed", () => {
    expect(resolveSettings({ commission: { loanInterestPct: 40 } }).legal).toEqual({ caseFeeDollars: 2750 });
  });

  it("keeps a stored fee and reports its change", () => {
    const after = resolveSettings({ legal: { caseFeeDollars: 3000 } });
    expect(after.legal.caseFeeDollars).toBe(3000);
    expect(settingsChanges(DEFAULT_SETTINGS, after)).toEqual([{ path: "legal.caseFeeDollars", from: 2750, to: 3000 }]);
    expect(SETTING_LABELS["legal.caseFeeDollars"]).toBe("Attorney & filing fee per case ($)");
  });
});
