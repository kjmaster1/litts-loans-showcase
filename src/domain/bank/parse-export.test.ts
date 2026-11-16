import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { fingerprintRows } from "./fingerprint";
import { excelSerialToUtc, ExportFormatError, parseBankExport } from "./parse-export";

const fixture = readFileSync("tests/fixtures/bank-export.xlsx");

describe("parseBankExport (anonymised real export)", () => {
  const parsed = parseBankExport(fixture);

  it("reads the header block", () => {
    expect(parsed).toMatchObject({
      walletId: "69811362",
      businessName: "Litt's Loans",
      timezone: "UTC-5",
      reportedBalanceCents: 18_533_100,
    });
  });

  it("parses every transaction without errors", () => {
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toHaveLength(1922);
  });

  it("reads times as UTC although the header says UTC-5 (ADR 0004)", () => {
    // Newest row: 2026-10-09 05:02:19 in the file.
    expect(parsed.rows[0].occurredAt.toISOString()).toBe("2026-10-09T05:02:19.000Z");
  });

  it("keeps the fingerprints made when the label was believed", () => {
    // Stored rows were fingerprinted with their time read as UTC-5 (5 hours later); re-imports must still match.
    const [first] = fingerprintRows(parsed.walletId, parsed.rows);
    const asBefore = { ...parsed.rows[0], occurredAt: new Date("2026-10-09T10:02:19.000Z") };
    const before = JSON.stringify([parsed.walletId, asBefore.occurredAt.toISOString(), asBefore.direction, asBefore.txType, asBefore.amountCents, asBefore.taxCents, asBefore.taxPercent, asBefore.sourceWallet, asBefore.targetWallet, asBefore.initiatorName, asBefore.initiatorStateId, asBefore.comment]);
    expect(first.fingerprint).toBe(createHash("sha256").update(before).digest("hex"));
  });

  it("derives direction from the wallets", () => {
    const counts = parsed.rows.reduce<Record<string, number>>((m, r) => ({ ...m, [r.direction]: (m[r.direction] ?? 0) + 1 }), {});
    // in: 1,261 transfers + 262 charges + 16 deposits + 2 seizures; out: 231 pay + 130 transfers + 20 deposits
    expect(counts).toEqual({ in: 1541, out: 381 });
  });

  it("gives identical rows distinct occurrence numbers", () => {
    const rows = fingerprintRows("69811362", [parsed.rows[0], parsed.rows[0], parsed.rows[1]]);
    expect(rows.map((r) => r.occurrence)).toEqual([0, 1, 0]);
    expect(rows[0].fingerprint).toBe(rows[1].fingerprint);
    expect(rows[0].fingerprint).not.toBe(rows[2].fingerprint);
  });

  it("produces unique (fingerprint, occurrence) keys for the whole export", () => {
    const keys = fingerprintRows("69811362", parsed.rows).map((r) => `${r.fingerprint}:${r.occurrence}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("parseBankExport rejects bad input", () => {
  function workbook(rows: unknown[][]) {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Sheet1");
    return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  }
  const header = ["Time", null, "Amount", "Transaction Type", "Wallet Source", "Wallet Target", "Name", "State ID", "Comment", "Tax ($)", "Tax(%)"];

  it("rejects a non-spreadsheet", () => {
    expect(() => parseBankExport(Buffer.from("not a spreadsheet at all"))).toThrow(ExportFormatError);
  });

  it("rejects another wallet's export", () => {
    const file = workbook([[null, "TIMEZONE:", "UTC-5"], [null, "Wallet ID:", "12345678"], [null, "Amount:", 10], [], [], header]);
    expect(() => parseBankExport(file)).toThrow(/not the business wallet/);
  });

  it("reports bad rows instead of guessing", () => {
    const file = workbook([
      [null, "TIMEZONE:", "UTC-5"],
      [null, "Wallet ID:", "69811362"],
      [null, "Amount:", 10],
      [],
      [],
      header,
      [46000.5, null, -5, "transfer", "1", "69811362", "X", 1, "c", null, null],
      [46000.5, null, 5, "transfer", "1", "2", "X", 1, "c", null, null],
    ]);
    expect(parseBankExport(file).errors.map((e) => e.message)).toEqual([
      "Amount is missing or not positive.",
      "Neither wallet on this row is the business wallet.",
    ]);
  });
});

describe("time helpers", () => {
  it("rounds Excel serials to whole seconds", () => {
    // 2026-10-09 05:02:19 as a serial with float noise.
    const serial = 46304 + (5 * 3600 + 2 * 60 + 19) / 86400 + 1e-9;
    expect(excelSerialToUtc(serial).toISOString()).toBe("2026-10-09T05:02:19.000Z");
  });

  it("matches the game: a payment the bank app shows at 09:54:41 (GMT+1) is 08:54:41 UTC", () => {
    // The owner's export of 12 Oct 2026 (ADR 0004): the $802 commission payment was stored at 13:54:41Z when read
    // as UTC-5, so its Time cell said 08:54:41, which is what the game shows.
    const serial = 46307 + (8 * 3600 + 54 * 60 + 41) / 86400;
    expect(excelSerialToUtc(serial).toISOString()).toBe("2026-10-12T08:54:41.000Z");
  });
});
