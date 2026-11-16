import "server-only";
import { sql } from "drizzle-orm";
import * as XLSX from "xlsx";
import { db } from "@/server/db";

/**
 * "Download everything" (research/11): every business table as one Excel sheet
 * each — a backup the owner can open. Sign-in secrets (password hashes, 2FA
 * secrets, passkeys, sessions, invite tokens) are never included.
 */
export const EXPORT_TABLES = [
  "staff",
  "import_batch",
  "bank_transaction",
  "journal_entry",
  "journal_line",
  "loan",
  "loan_payment_link",
  "loan_event",
  "loan_card",
  "loan_paste",
  "loan_adjustment",
  "loan_collateral",
  "loan_collection_action",
  "legal_case",
  "legal_case_handover",
  "legal_fee_link",
  "borrower_flag",
  "mortgage",
  "mortgage_payment",
  "mortgage_event",
  "mortgage_snapshot",
  "mortgage_paste",
  "mortgage_settlement",
  "allowance_reading",
  "app_setting",
  "company_setting",
  "commission_week",
  "commission_roster",
  "commission_line",
  "commission_award",
  "commission_payout",
  "loan_offer",
  "mortgage_quote",
  "mortgage_quote_note",
  "ledger_account",
  "audit_event",
] as const;

/**
 * Tables deliberately left out, with why. A test checks every table in the database is in exactly
 * one of the two lists, so a new table can't be forgotten (review 2026-10-13: issued contracts and
 * quotes had been missing since they were added).
 */
export const NOT_EXPORTED: Record<string, string> = {
  user: "sign-in account (username, placeholder email)",
  account: "password hashes",
  session: "sign-in sessions",
  two_factor: "authenticator secrets",
  passkey: "passkey credentials",
  verification: "sign-in tokens",
  rate_limit: "sign-in throttling counters",
  staff_invite: "invite tokens",
  staff_password_reset: "password reset tokens",
  import_staging: "uploads waiting for a decision; they expire within the hour",
  notification_read: "which notifications each person has seen",
  app_error: "server error log for the health check",
};

/** Excel's limit per cell. */
const MAX_CELL = 32_000;

function cell(v: unknown): string | number | boolean | Date | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "bigint") return Number(v);
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.length > MAX_CELL ? `${s.slice(0, MAX_CELL)}… (truncated)` : s;
}

export async function fullExport(): Promise<{ bytes: Uint8Array; rows: number }> {
  const wb = XLSX.utils.book_new();
  let total = 0;
  for (const table of EXPORT_TABLES) {
    // Table names come from the fixed list above, never from input.
    const result = await db.execute<Record<string, unknown>>(sql.raw(`select * from "${table}"`));
    const columns = result.fields.map((f) => f.name);
    const aoa = [columns, ...result.rows.map((r) => columns.map((c) => cell(r[c])))];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa, { cellDates: true }), table.slice(0, 31));
    total += result.rows.length;
  }
  const bytes = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Uint8Array;
  return { bytes, rows: total };
}
