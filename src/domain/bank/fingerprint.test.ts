import { describe, expect, it } from "vitest";
import { alreadyStored, fingerprintRow, identityKey } from "./fingerprint";
import type { ParsedRow } from "./parse-export";

const row: ParsedRow = {
  sheetRow: 7,
  occurredAt: new Date("2026-09-29T03:21:47Z"),
  direction: "in",
  txType: "Transfer",
  amountCents: 19_967_900,
  taxCents: 3_101_700,
  taxPercent: "15",
  sourceWallet: "40001",
  targetWallet: "69811362",
  initiatorName: "Cyan Oakhurst",
  initiatorStateId: 16754,
  comment: "118 Imagination Ct: Down Payment & Fees",
};

describe("recognising a transaction in a later export (renamed customer, 2026-10-13)", () => {
  const renamed = { ...row, initiatorName: "Cyan Spencer" };

  it("ignores the initiator's name, which the export shows as it is now", () => {
    expect(fingerprintRow("69811362", renamed)).not.toBe(fingerprintRow("69811362", row));
    expect(identityKey("69811362", renamed)).toBe(identityKey("69811362", row));
  });

  it("still tells apart another person's identical payment, or any other change", () => {
    expect(identityKey("69811362", { ...row, initiatorStateId: 9325 })).not.toBe(identityKey("69811362", row));
    expect(identityKey("69811362", { ...row, amountCents: row.amountCents + 100 })).not.toBe(identityKey("69811362", row));
    expect(identityKey("69811362", { ...row, occurredAt: new Date("2026-09-29T03:21:48Z") })).not.toBe(identityKey("69811362", row));
  });

  it("counts identical transactions: the second copy is new when only one is stored", () => {
    const k = identityKey("69811362", row);
    const other = identityKey("69811362", { ...row, comment: "x" });
    expect(alreadyStored([k, k, other], [k])).toEqual([true, false, false]);
    expect(alreadyStored([k, k], [k, k])).toEqual([true, true]);
    expect(alreadyStored([], [k])).toEqual([]);
  });
});
