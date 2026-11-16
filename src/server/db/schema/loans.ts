import { isNull, sql } from "drizzle-orm";
import { bigint, bigserial, boolean, check, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import { bankTransaction, journalEntry } from "./ledger";
import { mortgage } from "./mortgages";
import { staff } from "./staff";

/** See docs/design/LOANS.md. */

export const loanStatus = pgEnum("loan_status", ["active", "overdue", "defaulted", "written_off", "completed"]);
export const loanTab = pgEnum("loan_tab", ["active", "overdue", "default", "complete"]);

export const loan = pgTable(
  "loan",
  {
    id: uuid().primaryKey().defaultRandom(),
    borrowerStateId: integer().notNull(),
    borrowerName: text(),
    principalCents: bigint({ mode: "number" }).notNull(),
    /** Terms come from the phone cards; null until the first matching paste. */
    instalments: integer(),
    periodDays: integer(),
    /** Rates in hundredths of a percent (15% → 1500, 7.5% → 750). */
    brokerRateBp: integer(),
    stateRateBp: integer(),
    openedAt: timestamp({ withTimezone: true }),
    /** The "Loan Transfer" bank row — the loan's identity. Null for card-only loans. */
    disbursementTxId: uuid().references(() => bankTransaction.id),
    agreementRef: text(),
    status: loanStatus().notNull().default("active"),
    /** Set when staff overrode the game's status (e.g. repaid but stuck in the Default tab); pastes then leave it alone. */
    statusLocked: boolean().notNull().default(false),
    statusLockReason: text(),
    officerStaffId: uuid().references(() => staff.id),
    firstDefaultAt: timestamp({ withTimezone: true }),
    completedAt: timestamp({ withTimezone: true }),
    writtenOffAt: timestamp({ withTimezone: true }),
    writeOffEntryId: uuid().references(() => journalEntry.id),
    lastCardAt: timestamp({ withTimezone: true }),
    lastCardTab: loanTab(),
    /** Latest card snapshot fields, denormalised for the list view. */
    lastCompleted: integer(),
    lastMissed: integer(),
    lastRemainingCents: bigint({ mode: "number" }),
    nextPaymentDueAt: timestamp({ withTimezone: true }),
    /** Defaulted Account Fee per day from the signed contract, typed in by the officer (legal cases, 2026-11-10). */
    defaultFeePerDayCents: bigint({ mode: "number" }),
    /** No collateral was pledged: the case sheet says so instead of asking for it. */
    unsecured: boolean().notNull().default(false),
    /**
     * Set when a card-only loan was retired by hand — a duplicate or a mistake (2026-10-12).
     * Every query skips it (`liveLoan`); its history stays (events are append-only).
     */
    retiredAt: timestamp({ withTimezone: true }),
    /** The loan a retired duplicate was merged into, if it was one. */
    mergedIntoId: uuid().references((): AnyPgColumn => loan.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("loan_disbursement_uq").on(t.disbursementTxId),
    index("loan_borrower_idx").on(t.borrowerStateId),
    index("loan_status_idx").on(t.status),
    index("loan_officer_idx").on(t.officerStaffId),
    check("loan_principal_positive", sql`${t.principalCents} > 0`),
    // Only a loan with no bank money can be retired; a merge is a kind of retirement.
    check("loan_retired_card_only", sql`${t.retiredAt} is null or ${t.disbursementTxId} is null`),
    check("loan_merged_retired", sql`${t.mergedIntoId} is null or ${t.retiredAt} is not null`),
  ],
);

/** Loans that count: everything except card-only loans retired by hand. Use in every loan query. */
export const liveLoan = isNull(loan.retiredAt);

/** One paste of one phone tab. A weekly paste is the complete list for its tab. */
export const loanPaste = pgTable("loan_paste", {
  id: uuid().primaryKey().defaultRandom(),
  tab: loanTab().notNull(),
  capturedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  createdByStaffId: uuid().references(() => staff.id),
  cardCount: integer().notNull(),
  matchedCount: integer().notNull(),
  createdCount: integer().notNull(),
  ignoredCount: integer().notNull(),
});

/** Every card ever pasted, verbatim plus parsed — the loan's status history. */
export const loanCard = pgTable(
  "loan_card",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    pasteId: uuid()
      .notNull()
      .references(() => loanPaste.id),
    loanId: uuid().references(() => loan.id),
    position: integer().notNull(),
    raw: text().notNull(),
    parsed: jsonb().notNull(),
    matchHow: text(),
  },
  (t) => [index("loan_card_loan_idx").on(t.loanId), index("loan_card_paste_idx").on(t.pasteId)],
);

/** Bank row → loan, with the accounting entries the loan sync posted for it. */
export const loanPaymentLink = pgTable(
  "loan_payment_link",
  {
    bankTransactionId: uuid()
      .primaryKey()
      .references(() => bankTransaction.id),
    loanId: uuid()
      .notNull()
      .references(() => loan.id),
    role: text().notNull(),
    method: text().notNull(),
    levyCents: bigint({ mode: "number" }).notNull().default(0),
    /**
     * The game's +2%-per-missed-payment overdue penalty inside a principal instalment (`penaltyFor`): booked as a
     * late fee (4000), not principal (owner, 2026-10-13). Kept equal to what's booked by the loan sync.
     */
    penaltyCents: bigint({ mode: "number" }).notNull().default(0),
    levyEntryId: uuid().references(() => journalEntry.id),
    recoveryEntryId: uuid().references(() => journalEntry.id),
  },
  (t) => [index("loan_payment_link_loan_idx").on(t.loanId)],
);

/**
 * Closing adjustments: when the game marks a loan complete, whatever is left on
 * its receivable (rounding, game repayment bugs, payments the bank rows don't
 * attribute exactly) is cleared — a shortfall to 5110, a surplus to 4310.
 * Signed: positive = shortfall. Append-only; later receipts add another row.
 */
export const loanAdjustment = pgTable(
  "loan_adjustment",
  {
    id: uuid().primaryKey().defaultRandom(),
    loanId: uuid()
      .notNull()
      .references(() => loan.id),
    journalEntryId: uuid()
      .notNull()
      .references(() => journalEntry.id),
    kind: text().notNull(),
    amountCents: bigint({ mode: "number" }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("loan_adjustment_loan_idx").on(t.loanId), uniqueIndex("loan_adjustment_entry_uq").on(t.journalEntryId)],
);

/** Human-readable timeline of a loan (status changes, officer, write-off, notes). */
export const loanEvent = pgTable(
  "loan_event",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    loanId: uuid()
      .notNull()
      .references(() => loan.id),
    at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    kind: text().notNull(),
    detail: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    staffId: uuid().references(() => staff.id),
  },
  (t) => [index("loan_event_loan_idx").on(t.loanId, t.at)],
);

export const collateralStatus = pgEnum("collateral_status", ["held", "repossessed", "sold", "released"]);

/** Collateral is entered by hand (the game doesn't record it). */
export const loanCollateral = pgTable(
  "loan_collateral",
  {
    id: uuid().primaryKey().defaultRandom(),
    loanId: uuid()
      .notNull()
      .references(() => loan.id),
    description: text().notNull(),
    estimatedValueCents: bigint({ mode: "number" }),
    status: collateralStatus().notNull().default("held"),
    createdByStaffId: uuid().references(() => staff.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("loan_collateral_loan_idx").on(t.loanId)],
);

export const collectionKind = pgEnum("collection_kind", ["contacted", "no_answer", "promise", "handed_to_legal", "seizure", "note"]);

/**
 * Collections log for overdue and defaulted loans (research/11): append-only;
 * the latest entry's next-action date is the loan's next follow-up.
 */
export const loanCollectionAction = pgTable(
  "loan_collection_action",
  {
    id: uuid().primaryKey().defaultRandom(),
    /** Exactly one of loanId / mortgageId (late mortgages are chased too — research/12). */
    loanId: uuid().references(() => loan.id),
    mortgageId: uuid().references(() => mortgage.id),
    at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    staffId: uuid()
      .notNull()
      .references(() => staff.id),
    kind: collectionKind().notNull(),
    note: text().notNull().default(""),
    /** A promise to pay: how much, by when. */
    promiseCents: bigint({ mode: "number" }),
    promiseBy: timestamp({ withTimezone: true }),
    nextActionAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index("loan_collection_action_loan_idx").on(t.loanId, t.at),
    index("loan_collection_action_mortgage_idx").on(t.mortgageId, t.at),
    check("loan_collection_promise_whole_dollars", sql`${t.promiseCents} is null or ${t.promiseCents} % 100 = 0`),
    check("loan_collection_one_target", sql`(${t.loanId} is null) <> (${t.mortgageId} is null)`),
  ],
);

/** "Do not lend" flags on a borrower (research/11). Cleared, never deleted. */
export const borrowerFlag = pgTable(
  "borrower_flag",
  {
    id: uuid().primaryKey().defaultRandom(),
    borrowerStateId: integer().notNull(),
    reason: text().notNull(),
    setByStaffId: uuid()
      .notNull()
      .references(() => staff.id),
    setAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    clearedAt: timestamp({ withTimezone: true }),
    clearedByStaffId: uuid().references(() => staff.id),
    clearReason: text(),
  },
  (t) => [uniqueIndex("borrower_flag_open_uq").on(t.borrowerStateId).where(sql`${t.clearedAt} is null`)],
);
