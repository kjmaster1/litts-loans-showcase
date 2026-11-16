import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, between, eq, gt, inArray, isNull, lt, lte, max, ne, or, sql } from "drizzle-orm";
import { classify, mortgageAddress, RULESET_VERSION, type Confidence } from "@/domain/bank/classify";
import { alreadyStored, fingerprintRows, identityKey, type IdentityFields } from "@/domain/bank/fingerprint";
import { ExportFormatError, parseBankExport } from "@/domain/bank/parse-export";
import type { Category } from "@/domain/ledger/categories";
import { postingLines, type Line } from "@/domain/ledger/posting";
import { pairMortgageLegs, settlementLines, type Leg } from "@/domain/ledger/settlement";
import { ForbiddenError } from "@/lib/permissions";
import { recordAudit } from "@/server/audit/audit";
import { syncLoans } from "@/server/loans/sync";
import { syncMortgages } from "@/server/mortgages/sync";
import { syncPayouts } from "@/server/commissions/service";
import type { Viewer } from "@/server/authz/viewer";
import { db, type Tx } from "@/server/db";
import { bankTransaction, importBatch, importStaging, journalEntry, journalLine, mortgageSettlement } from "@/server/db/schema";
import { getRequestMeta } from "@/server/request";

/**
 * Bank export import: upload → parse → stage (preview) → commit
 * (docs/design/LEDGER.md §Import pipeline). Nothing touches the ledger until a
 * person confirms the preview.
 */

export const MAX_FILE_BYTES = 3_500_000;
const STAGING_TTL_MS = 60 * 60 * 1000;
const CHUNK = 500;

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportError";
  }
}

/** A row as stored in the staging payload (dates as ISO strings). */
type StagedRow = {
  sheetRow: number;
  occurredAt: string;
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
  fingerprint: string;
  occurrence: number;
  category: Category;
  confidence: Confidence;
  rule: string;
  address?: string;
  duplicate: boolean;
};

type StagedPayload = {
  walletId: string;
  businessName: string | null;
  timezone: string;
  reportedBalanceCents: number;
  rows: StagedRow[];
  errors: { sheetRow: number; message: string }[];
};

export type ImportPreview = {
  stagingId: string;
  fileName: string;
  timezone: string;
  reportedBalanceCents: number;
  totalRows: number;
  newRows: number;
  duplicateRows: number;
  errors: { sheetRow: number; message: string }[];
  firstTxAt: string | null;
  lastTxAt: string | null;
  byCategory: { category: Category; count: number; inCents: number; outCents: number }[];
  byConfidence: Record<Confidence, number>;
  review: { sheetRow: number; occurredAt: string; direction: "in" | "out"; amountCents: number; comment: string }[];
  /** Ledger cash now and after commit, vs the export's reported balance. */
  cashBeforeCents: number;
  cashAfterCents: number;
  /**
   * The books' cash as at the export's last row once this file is in — what the export's balance must equal,
   * because the books start from the account's first transaction. Exact, whatever order exports arrive in.
   */
  cashAtExportCents: number;
  /**
   * New rows dated before the latest row already in the books. An export never adds to the past, so these are
   * most likely rows the books already have under a different detail (a renamed customer, 2026-10-13).
   */
  backdated: { sheetRow: number; occurredAt: string; direction: "in" | "out"; amountCents: number; initiatorName: string | null; comment: string }[];
  expiresAt: string;
};

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function isXlsx(bytes: Uint8Array) {
  // .xlsx is a ZIP container: "PK\x03\x04".
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

type Executor = typeof db | Tx;

/** Signed cash effect of a row (the monthly tax record moves no money). */
const cashEffect = (r: { category: string; direction: "in" | "out"; amountCents: number; taxCents: number }) =>
  r.category === "tax.remittance_record" ? 0 : r.direction === "in" ? r.amountCents - r.taxCents : -r.amountCents;

/**
 * Which of an export's rows the books already have. Matched on every raw field except the initiator's name
 * (`identityKey`): the export shows a person's current name on their old rows too, and a rename once imported
 * two of them a second time (2026-10-13).
 */
async function alreadyImported(executor: Executor, walletId: string, rows: IdentityFields[]): Promise<boolean[]> {
  if (rows.length === 0) return [];
  const times = rows.map((r) => r.occurredAt.getTime());
  const stored = await executor
    .select({
      occurredAt: bankTransaction.occurredAt,
      direction: bankTransaction.direction,
      txType: bankTransaction.txType,
      amountCents: bankTransaction.amountCents,
      taxCents: bankTransaction.taxCents,
      taxPercent: bankTransaction.taxPercent,
      sourceWallet: bankTransaction.sourceWallet,
      targetWallet: bankTransaction.targetWallet,
      initiatorStateId: bankTransaction.initiatorStateId,
      comment: bankTransaction.comment,
    })
    .from(bankTransaction)
    .where(
      and(
        eq(bankTransaction.walletId, walletId),
        between(bankTransaction.occurredAt, new Date(Math.min(...times)), new Date(Math.max(...times))),
      ),
    );
  return alreadyStored(
    rows.map((r) => identityKey(walletId, r)),
    stored.map((r) => identityKey(walletId, r)),
  );
}

const identityOf = (r: StagedRow): IdentityFields => ({ ...r, occurredAt: new Date(r.occurredAt) });

async function existingKeys(executor: typeof db | Tx, fingerprints: string[]): Promise<Set<string>> {
  const keys = new Set<string>();
  const unique = [...new Set(fingerprints)];
  for (let i = 0; i < unique.length; i += CHUNK) {
    const rows = await executor
      .select({ f: bankTransaction.fingerprint, o: bankTransaction.occurrence })
      .from(bankTransaction)
      .where(inArray(bankTransaction.fingerprint, unique.slice(i, i + CHUNK)));
    for (const r of rows) keys.add(`${r.f}:${r.o}`);
  }
  return keys;
}

export async function cashBalanceCents(executor: typeof db | Tx = db): Promise<number> {
  const [row] = await executor
    .select({ v: sql<string>`coalesce(sum(${journalLine.debitCents} - ${journalLine.creditCents}), 0)` })
    .from(journalLine)
    .where(eq(journalLine.accountCode, "1000"));
  return Number(row?.v ?? 0);
}

/** Parses and classifies an upload, stores it for preview. Caller must hold `bank.import`. */
export async function stageImport(viewer: Viewer, file: { name: string; bytes: Uint8Array }): Promise<string> {
  if (file.bytes.length === 0) throw new ImportError("The file is empty.");
  if (file.bytes.length > MAX_FILE_BYTES) throw new ImportError("The file is too large (max 3.5 MB).");
  if (!isXlsx(file.bytes)) throw new ImportError("Upload the .xlsx file exported from the bank.");

  let parsed;
  try {
    parsed = parseBankExport(file.bytes);
  } catch (error) {
    if (error instanceof ExportFormatError) throw new ImportError(error.message);
    throw error;
  }

  const rows = fingerprintRows(parsed.walletId, parsed.rows);
  const stored = await alreadyImported(db, parsed.walletId, rows);
  const staged: StagedRow[] = rows.map((r, i) => {
    const c = classify(r);
    return {
      sheetRow: r.sheetRow,
      occurredAt: r.occurredAt.toISOString(),
      direction: r.direction,
      txType: r.txType,
      amountCents: r.amountCents,
      taxCents: r.taxCents,
      taxPercent: r.taxPercent,
      sourceWallet: r.sourceWallet,
      targetWallet: r.targetWallet,
      initiatorName: r.initiatorName,
      initiatorStateId: r.initiatorStateId,
      comment: r.comment,
      fingerprint: r.fingerprint,
      occurrence: r.occurrence,
      category: c.category,
      confidence: c.confidence,
      rule: c.rule,
      address: c.address,
      duplicate: stored[i],
    };
  });

  const payload: StagedPayload = {
    walletId: parsed.walletId,
    businessName: parsed.businessName,
    timezone: parsed.timezone,
    reportedBalanceCents: parsed.reportedBalanceCents,
    rows: staged,
    errors: parsed.errors,
  };

  // Housekeeping: drop expired staging rows.
  await db.delete(importStaging).where(lt(importStaging.expiresAt, new Date()));
  const [row] = await db
    .insert(importStaging)
    .values({
      createdByStaffId: viewer.staffId,
      fileName: file.name.slice(0, 200),
      fileSha256: sha256(file.bytes),
      payload,
      expiresAt: new Date(Date.now() + STAGING_TTL_MS),
    })
    .returning({ id: importStaging.id });
  return row.id;
}

async function loadStaging(viewer: Viewer, stagingId: string) {
  const row = await db.query.importStaging.findFirst({
    where: and(eq(importStaging.id, stagingId), eq(importStaging.createdByStaffId, viewer.staffId), gt(importStaging.expiresAt, new Date())),
  });
  if (!row) throw new ImportError("This preview has expired or doesn't exist. Upload the file again.");
  return { ...row, payload: row.payload as StagedPayload };
}

export async function getImportPreview(viewer: Viewer, stagingId: string): Promise<ImportPreview> {
  const staging = await loadStaging(viewer, stagingId);
  const { payload } = staging;
  const fresh = payload.rows.filter((r) => !r.duplicate);

  const byCategoryMap = new Map<Category, { count: number; inCents: number; outCents: number }>();
  const byConfidence: Record<Confidence, number> = { certain: 0, tag: 0, heuristic: 0, unclassified: 0 };
  for (const r of fresh) {
    const e = byCategoryMap.get(r.category) ?? { count: 0, inCents: 0, outCents: 0 };
    e.count++;
    if (r.direction === "in") e.inCents += r.amountCents;
    else e.outCents += r.amountCents;
    byCategoryMap.set(r.category, e);
    byConfidence[r.confidence]++;
  }

  const cashBefore = await cashBalanceCents();
  const cashDelta = fresh.reduce((s, r) => s + cashEffect(r), 0);
  const times = payload.rows.map((r) => r.occurredAt).sort();
  const lastTx = times.length ? new Date(times[times.length - 1]) : null;
  const [[atExport], [latest]] = await Promise.all([
    lastTx
      ? db
          .select({ v: sql<string>`coalesce(sum(case when ${bankTransaction.direction} = 'in' then ${bankTransaction.amountCents} - ${bankTransaction.taxCents} else -${bankTransaction.amountCents} end), 0)` })
          .from(bankTransaction)
          .where(and(eq(bankTransaction.walletId, payload.walletId), lte(bankTransaction.occurredAt, lastTx), ne(bankTransaction.category, "tax.remittance_record")))
      : [{ v: "0" }],
    db.select({ at: max(bankTransaction.occurredAt) }).from(bankTransaction).where(eq(bankTransaction.walletId, payload.walletId)),
  ]);

  return {
    stagingId,
    fileName: staging.fileName,
    timezone: payload.timezone,
    reportedBalanceCents: payload.reportedBalanceCents,
    totalRows: payload.rows.length,
    newRows: fresh.length,
    duplicateRows: payload.rows.length - fresh.length,
    errors: payload.errors,
    firstTxAt: times[0] ?? null,
    lastTxAt: times[times.length - 1] ?? null,
    byCategory: [...byCategoryMap].map(([category, v]) => ({ category, ...v })).sort((a, b) => b.count - a.count),
    byConfidence,
    review: fresh
      .filter((r) => r.category === "unclassified")
      .map((r) => ({ sheetRow: r.sheetRow, occurredAt: r.occurredAt, direction: r.direction, amountCents: r.amountCents, comment: r.comment })),
    cashBeforeCents: cashBefore,
    cashAfterCents: cashBefore + cashDelta,
    cashAtExportCents: Number(atExport?.v ?? 0) + cashDelta,
    backdated: fresh
      .filter((r) => latest?.at && new Date(r.occurredAt) < latest.at)
      .map((r) => ({ sheetRow: r.sheetRow, occurredAt: r.occurredAt, direction: r.direction, amountCents: r.amountCents, initiatorName: r.initiatorName, comment: r.comment })),
    expiresAt: staging.expiresAt.toISOString(),
  };
}

type EntryInsert = typeof journalEntry.$inferInsert;
type LineInsert = typeof journalLine.$inferInsert;

function toLineRows(entryId: string, lines: Line[]): LineInsert[] {
  return lines.map((l) => ({ entryId, accountCode: l.account, debitCents: l.debit, creditCents: l.credit, memo: l.memo ?? null }));
}

async function insertChunked<T>(items: T[], insert: (chunk: T[]) => Promise<unknown>) {
  for (let i = 0; i < items.length; i += CHUNK) await insert(items.slice(i, i + CHUNK));
}

/** Legs already in the ledger that aren't part of an active settlement. */
async function unpairedLegs(tx: Tx): Promise<Leg[]> {
  const rows = await tx
    .select({
      id: bankTransaction.id,
      category: bankTransaction.category,
      comment: bankTransaction.comment,
      occurredAt: bankTransaction.occurredAt,
      amountCents: bankTransaction.amountCents,
      taxCents: bankTransaction.taxCents,
    })
    .from(bankTransaction)
    .leftJoin(
      mortgageSettlement,
      and(
        isNull(mortgageSettlement.unwoundAt),
        or(eq(mortgageSettlement.inTxId, bankTransaction.id), eq(mortgageSettlement.outTxId, bankTransaction.id)),
      ),
    )
    .where(
      and(
        inArray(bankTransaction.category, ["mortgage.origination_in", "mortgage.origination_out", "mortgage.repayment_in", "mortgage.repayment_out"]),
        isNull(mortgageSettlement.id),
      ),
    );
  return rows.map((r) => ({
    id: r.id,
    category: r.category as Category,
    address: mortgageAddress(r.comment) ?? "",
    occurredAt: r.occurredAt,
    amountCents: r.amountCents,
    taxCents: r.taxCents,
  }));
}

/** Imports 1 batch atomically. Caller must hold `bank.import`. */
export async function commitImport(viewer: Viewer, stagingId: string): Promise<{ batchId: string; newRows: number }> {
  const staging = await loadStaging(viewer, stagingId);
  const { payload } = staging;
  const request = await getRequestMeta();

  const result = await db.transaction(async (tx) => {
    // Serialise imports so two concurrent uploads can't both insert the same rows.
    await tx.execute(sql`select pg_advisory_xact_lock(${0x4c4c494d})`); // "LLIM"
    const stored = await alreadyImported(tx, payload.walletId, payload.rows.map(identityOf));
    const fresh = payload.rows.filter((_, i) => !stored[i]);
    // The hash includes the name, so a genuinely new row can only collide with a stored one in theory; give it
    // the next free occurrence rather than fail the import.
    const taken = await existingKeys(tx, fresh.map((r) => r.fingerprint));
    for (const r of fresh) {
      while (taken.has(`${r.fingerprint}:${r.occurrence}`)) r.occurrence++;
      taken.add(`${r.fingerprint}:${r.occurrence}`);
    }
    const times = payload.rows.map((r) => r.occurredAt).sort();

    const batchId = randomUUID();
    await tx.insert(importBatch).values({
      id: batchId,
      kind: "bank_xlsx",
      fileName: staging.fileName,
      fileSha256: staging.fileSha256,
      walletId: payload.walletId,
      exportTimezone: payload.timezone,
      reportedBalanceCents: payload.reportedBalanceCents,
      firstTxAt: times[0] ? new Date(times[0]) : null,
      lastTxAt: times.length ? new Date(times[times.length - 1]) : null,
      rowCount: payload.rows.length,
      newCount: fresh.length,
      duplicateCount: payload.rows.length - fresh.length,
      rulesetVersion: RULESET_VERSION,
      createdByStaffId: viewer.staffId,
    });

    // Oldest first so journal order follows time.
    fresh.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.sheetRow - b.sheetRow);
    const txRows: (typeof bankTransaction.$inferInsert)[] = [];
    const entries: EntryInsert[] = [];
    const lines: LineInsert[] = [];

    for (const r of fresh) {
      const txId = randomUUID();
      const entryId = randomUUID();
      const occurredAt = new Date(r.occurredAt);
      txRows.push({
        id: txId,
        batchId,
        walletId: payload.walletId,
        occurredAt,
        direction: r.direction,
        txType: r.txType,
        amountCents: r.amountCents,
        taxCents: r.taxCents,
        taxPercent: r.taxPercent,
        sourceWallet: r.sourceWallet,
        targetWallet: r.targetWallet,
        initiatorName: r.initiatorName,
        initiatorStateId: r.initiatorStateId,
        comment: r.comment,
        fingerprint: r.fingerprint,
        occurrence: r.occurrence,
        category: r.category,
        confidence: r.confidence,
        rulesetVersion: RULESET_VERSION,
        postingEntryId: entryId,
      });
      entries.push({
        id: entryId,
        effectiveAt: occurredAt,
        kind: "bank_posting",
        description: r.comment.trim().slice(0, 300) || r.txType,
        bankTransactionId: txId,
        batchId,
        createdByStaffId: viewer.staffId,
      });
      lines.push(...toLineRows(entryId, postingLines(r)));
    }

    await insertChunked(txRows, (c) => tx.insert(bankTransaction).values(c));
    await insertChunked(entries, (c) => tx.insert(journalEntry).values(c));
    await insertChunked(lines, (c) => tx.insert(journalLine).values(c));

    // Pair mortgage legs. The query sees the rows just inserted (same transaction)
    // as well as any earlier leg still waiting for its partner.
    const pairs = pairMortgageLegs(await unpairedLegs(tx));
    const settleEntries: EntryInsert[] = [];
    const settleLines: LineInsert[] = [];
    const settlements: (typeof mortgageSettlement.$inferInsert)[] = [];
    for (const p of pairs) {
      const sl = settlementLines(p);
      const entryId = sl.length ? randomUUID() : null;
      if (entryId) {
        const later = p.inLeg.occurredAt > p.outLeg.occurredAt ? p.inLeg.occurredAt : p.outLeg.occurredAt;
        settleEntries.push({
          id: entryId,
          effectiveAt: later,
          kind: "mortgage_settlement",
          description: `${p.kind === "origination" ? "Broker fee" : "Broker interest"} — ${p.address}`,
          batchId,
          createdByStaffId: viewer.staffId,
        });
        settleLines.push(...toLineRows(entryId, sl));
      }
      settlements.push({ kind: p.kind, address: p.address, inTxId: p.inLeg.id, outTxId: p.outLeg.id, journalEntryId: entryId });
    }
    await insertChunked(settleEntries, (c) => tx.insert(journalEntry).values(c));
    await insertChunked(settleLines, (c) => tx.insert(journalLine).values(c));
    await insertChunked(settlements, (c) => tx.insert(mortgageSettlement).values(c));

    await tx.delete(importStaging).where(eq(importStaging.id, stagingId));

    // New disbursements become loans and new payments are linked to them.
    const loans = await syncLoans(tx);
    const mortgages = await syncMortgages(tx);
    const commissionPayouts = await syncPayouts(tx);
    const cash = await cashBalanceCents(tx);
    await recordAudit(tx, {
      actor: { type: "staff", staffId: viewer.staffId },
      action: "bank.import.committed",
      target: { type: "import_batch", id: batchId },
      metadata: {
        fileName: staging.fileName,
        fileSha256: staging.fileSha256,
        rows: payload.rows.length,
        newRows: fresh.length,
        duplicates: payload.rows.length - fresh.length,
        unclassified: fresh.filter((r) => r.category === "unclassified").length,
        mortgageSettlements: settlements.length,
        loans,
        mortgages,
        commissionPayouts,
        cashAfterCents: cash,
        reportedBalanceCents: payload.reportedBalanceCents,
      },
      request,
    });
    return { batchId, newRows: fresh.length };
  });

  return result;
}

export async function discardStaging(viewer: Viewer, stagingId: string): Promise<void> {
  const deleted = await db
    .delete(importStaging)
    .where(and(eq(importStaging.id, stagingId), eq(importStaging.createdByStaffId, viewer.staffId)))
    .returning({ id: importStaging.id });
  if (deleted.length === 0) throw new ForbiddenError("Nothing to discard.");
}
