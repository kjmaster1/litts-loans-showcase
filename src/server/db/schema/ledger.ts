import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/** See docs/design/LEDGER.md. All money is integer cents. */

export const accountType = pgEnum("ledger_account_type", ["asset", "liability", "equity", "income", "expense", "memo"]);

/** Chart of accounts — seeded by migration, referenced by code. */
export const ledgerAccount = pgTable("ledger_account", {
  code: text().primaryKey(),
  name: text().notNull(),
  type: accountType().notNull(),
  description: text(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const importBatch = pgTable(
  "import_batch",
  {
    id: uuid().primaryKey().defaultRandom(),
    kind: text().notNull(), // "bank_xlsx"
    fileName: text().notNull(),
    fileSha256: text().notNull(),
    walletId: text().notNull(),
    exportTimezone: text().notNull(),
    /** Balance printed in the export header at export time. */
    reportedBalanceCents: bigint({ mode: "number" }).notNull(),
    firstTxAt: timestamp({ withTimezone: true }),
    lastTxAt: timestamp({ withTimezone: true }),
    rowCount: integer().notNull(),
    newCount: integer().notNull(),
    duplicateCount: integer().notNull(),
    rulesetVersion: integer().notNull(),
    createdByStaffId: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("import_batch_created_at_idx").on(t.createdAt)],
);

/** Parsed-but-not-committed upload, shown on the preview screen. Expires. */
export const importStaging = pgTable("import_staging", {
  id: uuid().primaryKey().defaultRandom(),
  createdByStaffId: uuid().notNull(),
  fileName: text().notNull(),
  fileSha256: text().notNull(),
  payload: jsonb().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
});

export const txDirection = pgEnum("bank_tx_direction", ["in", "out"]);
export const classificationConfidence = pgEnum("classification_confidence", ["certain", "tag", "heuristic", "unclassified", "manual"]);

/**
 * One row of a bank export. Raw columns are immutable (trigger); only the
 * classification columns change, and only via reversal + repost.
 */
export const bankTransaction = pgTable(
  "bank_transaction",
  {
    id: uuid().primaryKey().defaultRandom(),
    batchId: uuid()
      .notNull()
      .references(() => importBatch.id),
    walletId: text().notNull(),
    occurredAt: timestamp({ withTimezone: true }).notNull(),
    direction: txDirection().notNull(),
    txType: text().notNull(),
    amountCents: bigint({ mode: "number" }).notNull(),
    taxCents: bigint({ mode: "number" }).notNull().default(0),
    taxPercent: text(),
    sourceWallet: text(),
    targetWallet: text(),
    initiatorName: text(),
    initiatorStateId: integer(),
    comment: text().notNull(),
    fingerprint: text().notNull(),
    occurrence: integer().notNull(),
    // --- classification (mutable via reclassification) ---
    category: text().notNull(),
    confidence: classificationConfidence().notNull(),
    rulesetVersion: integer().notNull(),
    classifiedByStaffId: uuid(),
    postingEntryId: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("bank_tx_fingerprint_occurrence_uq").on(t.fingerprint, t.occurrence),
    index("bank_tx_occurred_at_idx").on(t.occurredAt),
    index("bank_tx_category_idx").on(t.category),
    index("bank_tx_initiator_state_id_idx").on(t.initiatorStateId),
    check("bank_tx_amount_positive", sql`${t.amountCents} > 0`),
    check("bank_tx_tax_nonnegative", sql`${t.taxCents} >= 0 and ${t.taxCents} <= ${t.amountCents}`),
  ],
);

export const journalKind = pgEnum("journal_entry_kind", ["bank_posting", "reversal", "mortgage_settlement", "adjustment"]);

/** Immutable journal header. Corrections are new `reversal` entries. */
export const journalEntry = pgTable(
  "journal_entry",
  {
    id: uuid().primaryKey().defaultRandom(),
    /** Accounting date (the bank transaction's time for postings). */
    effectiveAt: timestamp({ withTimezone: true }).notNull(),
    recordedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    kind: journalKind().notNull(),
    description: text().notNull(),
    bankTransactionId: uuid().references(() => bankTransaction.id),
    reversesEntryId: uuid(),
    batchId: uuid().references(() => importBatch.id),
    createdByStaffId: uuid(),
    reason: text(),
  },
  (t) => [
    index("journal_entry_effective_at_idx").on(t.effectiveAt),
    index("journal_entry_bank_tx_idx").on(t.bankTransactionId),
    uniqueIndex("journal_entry_reverses_uq").on(t.reversesEntryId),
  ],
);

export const journalLine = pgTable(
  "journal_line",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    entryId: uuid()
      .notNull()
      .references(() => journalEntry.id),
    accountCode: text()
      .notNull()
      .references(() => ledgerAccount.code),
    debitCents: bigint({ mode: "number" }).notNull().default(0),
    creditCents: bigint({ mode: "number" }).notNull().default(0),
    memo: text(),
  },
  (t) => [
    index("journal_line_entry_idx").on(t.entryId),
    index("journal_line_account_idx").on(t.accountCode),
    check(
      "journal_line_one_sided",
      sql`${t.debitCents} >= 0 and ${t.creditCents} >= 0 and ((${t.debitCents} = 0) <> (${t.creditCents} = 0))`,
    ),
  ],
);

/** Links the two legs of a mortgage pass-through and the entry recognising the residual. */
export const mortgageSettlement = pgTable(
  "mortgage_settlement",
  {
    id: uuid().primaryKey().defaultRandom(),
    kind: text().notNull(), // "origination" | "repayment"
    address: text().notNull(),
    inTxId: uuid()
      .notNull()
      .references(() => bankTransaction.id),
    outTxId: uuid()
      .notNull()
      .references(() => bankTransaction.id),
    journalEntryId: uuid().references(() => journalEntry.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Set when a reclassification unwinds the pairing. */
    unwoundAt: timestamp({ withTimezone: true }),
  },
  (t) => [index("mortgage_settlement_in_idx").on(t.inTxId), index("mortgage_settlement_out_idx").on(t.outTxId)],
);
