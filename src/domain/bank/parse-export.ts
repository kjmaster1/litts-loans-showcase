import { formatCount } from "@/lib/format";
import * as XLSX from "xlsx";
import { dollarsToCents } from "@/lib/money";
import { BUSINESS_WALLET } from "./constants";

/**
 * Parser for the in-game bank's .xlsx export (format documented in
 * docs/research/01-source-data-analysis.md §2). Pure: Buffer in, data out.
 *
 * Layout: rows 1–3 are a header block of label/value pairs ("Wallet ID:",
 * "Amount:", "TIMEZONE:" …), then a table whose header row starts with "Time".
 * Columns are located by header name, not position, so a reordered export
 * still parses. Timestamps are UTC whatever the header's TIMEZONE label says: every export so far
 * is labelled "UTC-5" but its times are UTC (docs/decisions/0004-bank-export-times-are-utc.md).
 */

export type ParsedRow = {
  /** 1-based spreadsheet row number, for error messages. */
  sheetRow: number;
  occurredAt: Date;
  direction: "in" | "out";
  txType: string;
  amountCents: number;
  taxCents: number;
  taxPercent: string | null;
  sourceWallet: string | null;
  targetWallet: string | null;
  initiatorName: string | null;
  initiatorStateId: number | null;
  comment: string;
};

export type ParsedExport = {
  walletId: string;
  walletName: string | null;
  businessName: string | null;
  ownerName: string | null;
  ownerStateId: number | null;
  /** The header's TIMEZONE label, kept for the record only: the times are UTC (ADR 0004). */
  timezone: string;
  reportedBalanceCents: number;
  rows: ParsedRow[];
  errors: { sheetRow: number; message: string }[];
};

export class ExportFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportFormatError";
  }
}

export const MAX_EXPORT_ROWS = 50_000;

type Cell = string | number | boolean | null | undefined;

function str(v: Cell): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function num(v: Cell): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * Excel serial date (a UTC wall clock) → UTC instant, rounded to the second
 * (the bank records whole seconds).
 */
export function excelSerialToUtc(serial: number): Date {
  return new Date(Math.round(((serial - 25569) * 86_400_000) / 1000) * 1000);
}

/** Collects "Label:" → next-cell value pairs from the header block. */
function headerPairs(rows: Cell[][]): Map<string, Cell> {
  const pairs = new Map<string, Cell>();
  for (const row of rows) {
    for (let i = 0; i < row.length - 1; i++) {
      const label = str(row[i]);
      if (label?.endsWith(":")) pairs.set(label.slice(0, -1).toLowerCase(), row[i + 1]);
    }
  }
  return pairs;
}

const COLUMNS = {
  time: "time",
  amount: "amount",
  type: "transaction type",
  source: "wallet source",
  target: "wallet target",
  name: "name",
  stateId: "state id",
  comment: "comment",
  taxDollars: "tax ($)",
  taxPercent: "tax(%)",
} as const;

export function parseBankExport(file: ArrayBuffer | Uint8Array): ParsedExport {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(file, { type: "array", dense: true, cellFormula: false, cellHTML: false, cellText: false });
  } catch {
    throw new ExportFormatError("This file isn't a readable .xlsx spreadsheet.");
  }
  const sheet = workbook.Sheets[workbook.SheetNames[0] ?? ""];
  if (!sheet) throw new ExportFormatError("The spreadsheet has no sheets.");
  const grid = XLSX.utils.sheet_to_json<Cell[]>(sheet, { header: 1, raw: true, blankrows: true, defval: null });

  const headerRowIndex = grid.findIndex((r) => r.some((c) => str(c)?.toLowerCase() === COLUMNS.time));
  if (headerRowIndex < 0) throw new ExportFormatError('Couldn\'t find the transactions table (no "Time" header).');
  if (grid.length - headerRowIndex - 1 > MAX_EXPORT_ROWS) {
    throw new ExportFormatError(`Exports are limited to ${formatCount(MAX_EXPORT_ROWS)} rows.`);
  }

  const meta = headerPairs(grid.slice(0, headerRowIndex));
  const walletId = str(meta.get("wallet id"));
  if (!walletId) throw new ExportFormatError("The export header has no Wallet ID.");
  if (walletId !== BUSINESS_WALLET) {
    throw new ExportFormatError(`This export is for wallet ${walletId}, not the business wallet ${BUSINESS_WALLET}.`);
  }
  const timezone = str(meta.get("timezone"));
  if (!timezone) throw new ExportFormatError("The export header has no TIMEZONE.");
  const balance = num(meta.get("amount"));
  if (balance === null) throw new ExportFormatError("The export header has no balance (Amount).");

  const header = grid[headerRowIndex].map((c) => str(c)?.toLowerCase() ?? "");
  const col = Object.fromEntries(
    Object.entries(COLUMNS).map(([key, label]) => [key, header.indexOf(label)]),
  ) as Record<keyof typeof COLUMNS, number>;
  const missing = Object.entries(col).filter(([, i]) => i < 0).map(([k]) => COLUMNS[k as keyof typeof COLUMNS]);
  if (missing.length) throw new ExportFormatError(`The transactions table is missing columns: ${missing.join(", ")}.`);

  const rows: ParsedRow[] = [];
  const errors: ParsedExport["errors"] = [];

  for (let i = headerRowIndex + 1; i < grid.length; i++) {
    const r = grid[i];
    const sheetRow = i + 1;
    if (!r || r.every((c) => c === null || c === "")) continue;

    // Export quirk: the "Time" header sits one column right of the time values
    // (header in B, values in A, B blank on data rows). Accept either position.
    const time = typeof r[col.time] === "number" ? r[col.time] : col.time > 0 ? r[col.time - 1] : undefined;
    const amount = num(r[col.amount]);
    const txType = str(r[col.type]);
    const sourceWallet = str(r[col.source]);
    const targetWallet = str(r[col.target]);

    if (typeof time !== "number") {
      errors.push({ sheetRow, message: "Time is not a date." });
      continue;
    }
    if (amount === null || amount <= 0) {
      errors.push({ sheetRow, message: "Amount is missing or not positive." });
      continue;
    }
    if (!txType) {
      errors.push({ sheetRow, message: "Transaction Type is missing." });
      continue;
    }
    const direction = targetWallet === walletId ? "in" : sourceWallet === walletId ? "out" : null;
    if (!direction) {
      errors.push({ sheetRow, message: "Neither wallet on this row is the business wallet." });
      continue;
    }

    const stateIdRaw = num(r[col.stateId]);
    const taxDollars = num(r[col.taxDollars]) ?? 0;
    const taxPercent = num(r[col.taxPercent]);
    const amountCents = dollarsToCents(amount);
    const taxCents = dollarsToCents(taxDollars);
    if (taxCents < 0 || taxCents > amountCents) {
      errors.push({ sheetRow, message: "Tax is negative or larger than the amount." });
      continue;
    }

    rows.push({
      sheetRow,
      occurredAt: excelSerialToUtc(time),
      direction,
      txType: txType.toLowerCase(),
      amountCents,
      taxCents,
      taxPercent: taxPercent === null ? null : String(taxPercent),
      sourceWallet,
      targetWallet,
      initiatorName: str(r[col.name]),
      initiatorStateId: stateIdRaw === null ? null : Math.trunc(stateIdRaw),
      // Keep the comment byte-for-byte (trailing spaces included) — it's part of the fingerprint.
      comment: r[col.comment] === null || r[col.comment] === undefined ? "" : String(r[col.comment]),
    });
  }

  const ownerStateId = num(meta.get("owner state id"));
  return {
    walletId,
    walletName: str(meta.get("name")),
    businessName: str(meta.get("business name")),
    ownerName: str(meta.get("owner name")),
    ownerStateId: ownerStateId === null ? null : Math.trunc(ownerStateId),
    timezone,
    reportedBalanceCents: dollarsToCents(balance),
    rows,
    errors,
  };
}
