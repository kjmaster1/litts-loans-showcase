import { sql } from "drizzle-orm";
import { bigint, bigserial, check, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import { bankTransaction, journalEntry } from "./ledger";
import { staff } from "./staff";

/** See docs/design/MORTGAGES.md. */

export const mortgageStatus = pgEnum("mortgage_status", ["active", "completed", "defaulted"]);
/** Who lends the principal: the State (usual) or Litt's own money (small mortgages). */
export const mortgageFunding = pgEnum("mortgage_funding", ["state", "company"]);

export const mortgage = pgTable(
  "mortgage",
  {
    id: uuid().primaryKey().defaultRandom(),
    address: text().notNull(),
    /** Earlier addresses of the same property (the server sometimes renumbers houses). */
    addressAliases: text().array().notNull().default(sql`'{}'::text[]`),
    /** Set when this record turned out to duplicate another (kept for its history). */
    mergedIntoId: uuid().references((): AnyPgColumn => mortgage.id),
    /** The "<addr>: Down Payment & Fees" bank row — the mortgage's identity. Null until imported. */
    originationTxId: uuid().references(() => bankTransaction.id),
    originatedAt: timestamp({ withTimezone: true }),
    buyerStateId: integer(),
    buyerName: text(),
    status: mortgageStatus().notNull().default("active"),
    funding: mortgageFunding().notNull().default("state"),
    /** Company-funded: the entry that turned the origination residual into a receivable (1120). */
    fundingEntryId: uuid().references(() => journalEntry.id),
    /** Terms and parties come from the tablet; null until pasted. */
    propertyType: text(),
    landCount: integer(),
    priceCents: bigint({ mode: "number" }),
    downPaymentCents: bigint({ mode: "number" }),
    loanCents: bigint({ mode: "number" }),
    brokerInterestCents: bigint({ mode: "number" }),
    federalInterestCents: bigint({ mode: "number" }),
    instalments: integer(),
    termMonths: integer(),
    fedRateBp: integer(),
    brokerRateBp: integer(),
    lateFeeCents: bigint({ mode: "number" }),
    gracePeriodDays: integer(),
    brokerFeeCents: bigint({ mode: "number" }),
    agencyCommissionCents: bigint({ mode: "number" }),
    ownerName: text(),
    agencyName: text(),
    agentStateId: integer(),
    agentName: text(),
    officerStateId: integer(),
    officerName: text(),
    officerStaffId: uuid().references(() => staff.id),
    lastTabletAt: timestamp({ withTimezone: true }),
    lastPaidCount: integer(),
    lastRemainingCents: bigint({ mode: "number" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("mortgage_origination_uq").on(t.originationTxId),
    index("mortgage_address_idx").on(t.address),
    index("mortgage_buyer_idx").on(t.buyerStateId),
    index("mortgage_officer_idx").on(t.officerStaffId),
  ],
);

/** Repayment bank row ("<addr>: Loan Repayment", in-leg) → mortgage. */
export const mortgagePayment = pgTable(
  "mortgage_payment",
  {
    bankTransactionId: uuid()
      .primaryKey()
      .references(() => bankTransaction.id),
    mortgageId: uuid()
      .notNull()
      .references(() => mortgage.id),
    /** Company-funded: the entry splitting the repayment into principal (1120) and interest (4110). */
    entryId: uuid().references(() => journalEntry.id),
  },
  (t) => [index("mortgage_payment_mortgage_idx").on(t.mortgageId)],
);

export const mortgagePaste = pgTable("mortgage_paste", {
  id: uuid().primaryKey().defaultRandom(),
  capturedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  createdByStaffId: uuid().references(() => staff.id),
  count: integer().notNull(),
});

/** Every tablet agreement ever pasted, verbatim plus parsed. */
export const mortgageSnapshot = pgTable(
  "mortgage_snapshot",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    pasteId: uuid()
      .notNull()
      .references(() => mortgagePaste.id),
    mortgageId: uuid().references(() => mortgage.id),
    raw: text().notNull(),
    parsed: jsonb().notNull(),
  },
  (t) => [index("mortgage_snapshot_mortgage_idx").on(t.mortgageId)],
);

export const mortgageEvent = pgTable(
  "mortgage_event",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    mortgageId: uuid()
      .notNull()
      .references(() => mortgage.id),
    at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    kind: text().notNull(),
    detail: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    staffId: uuid().references(() => staff.id),
  },
  (t) => [index("mortgage_event_mortgage_idx").on(t.mortgageId, t.at)],
);

/** "State Allowance Balance" as seen on the phone. Voided, never edited. */
export const allowanceReading = pgTable(
  "allowance_reading",
  {
    id: uuid().primaryKey().defaultRandom(),
    observedAt: timestamp({ withTimezone: true }).notNull(),
    balanceCents: bigint({ mode: "number" }).notNull(),
    note: text(),
    createdByStaffId: uuid().references(() => staff.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    voidedAt: timestamp({ withTimezone: true }),
    voidedByStaffId: uuid().references(() => staff.id),
    voidReason: text(),
  },
  (t) => [index("allowance_reading_observed_idx").on(t.observedAt), check("allowance_reading_whole_dollars", sql`${t.balanceCents} % 100 = 0`)],
);

/** Small company settings (e.g. the adopted allowance rule). Changes are audited. */
export const appSetting = pgTable("app_setting", {
  key: text().primaryKey(),
  value: jsonb().notNull(),
  updatedByStaffId: uuid().references(() => staff.id),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
