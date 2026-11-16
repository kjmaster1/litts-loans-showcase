import { createHash } from "node:crypto";
import type { ParsedRow } from "./parse-export";

/**
 * The bank export has no transaction ID, so a row's identity is a hash of all
 * its raw fields. Genuinely identical rows (same second, same everything) get
 * an occurrence index in file order, so `(fingerprint, occurrence)` is unique
 * and re-importing overlapping date ranges is idempotent (docs/design/LEDGER.md).
 *
 * The time in the hash is the row's time + 5 hours: fingerprints were first made when the export's
 * "UTC-5" label was believed, and every stored row carries one. Hashing the same value keeps a
 * re-imported row recognised (ADR 0004).
 */
export const FINGERPRINT_CLOCK_SHIFT_MS = 5 * 3_600_000;

export function fingerprintRow(walletId: string, row: ParsedRow): string {
  const canonical = JSON.stringify([
    walletId,
    new Date(row.occurredAt.getTime() + FINGERPRINT_CLOCK_SHIFT_MS).toISOString(),
    row.direction,
    row.txType,
    row.amountCents,
    row.taxCents,
    row.taxPercent,
    row.sourceWallet,
    row.targetWallet,
    row.initiatorName,
    row.initiatorStateId,
    row.comment,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

/** The raw fields `identityKey` reads: a parsed row, or a stored one. */
export type IdentityFields = Pick<
  ParsedRow,
  "occurredAt" | "direction" | "txType" | "amountCents" | "taxCents" | "taxPercent" | "sourceWallet" | "targetWallet" | "initiatorStateId" | "comment"
>;

/**
 * Which bank transaction a row is, for recognising it in a later export: every raw field except the
 * initiator's name. The export prints each person's *current* name on all their rows, past ones too, so a
 * name change made already-imported rows look new (Cyan Oakhurst → Cyan Spencer, 2026-10-13). The State ID
 * stays in, so another person's identical payment still counts as a different transaction.
 */
export function identityKey(walletId: string, row: IdentityFields): string {
  return JSON.stringify([
    walletId,
    row.occurredAt.toISOString(),
    row.direction,
    row.txType,
    row.amountCents,
    row.taxCents,
    row.taxPercent,
    row.sourceWallet,
    row.targetWallet,
    row.initiatorStateId,
    row.comment,
  ]);
}

/**
 * Which incoming rows are already stored. Identical transactions (same second, same everything) are counted:
 * the n-th incoming copy of a transaction is stored if at least n copies are.
 */
export function alreadyStored(incomingKeys: string[], storedKeys: string[]): boolean[] {
  const stored = new Map<string, number>();
  for (const k of storedKeys) stored.set(k, (stored.get(k) ?? 0) + 1);
  const seen = new Map<string, number>();
  return incomingKeys.map((k) => {
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    return n < (stored.get(k) ?? 0);
  });
}

export type FingerprintedRow = ParsedRow & { fingerprint: string; occurrence: number };

export function fingerprintRows(walletId: string, rows: ParsedRow[]): FingerprintedRow[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const fingerprint = fingerprintRow(walletId, row);
    const occurrence = seen.get(fingerprint) ?? 0;
    seen.set(fingerprint, occurrence + 1);
    return { ...row, fingerprint, occurrence };
  });
}
