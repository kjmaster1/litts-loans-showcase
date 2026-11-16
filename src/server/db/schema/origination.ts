import { sql } from "drizzle-orm";
import { bigint, boolean, index, integer, pgEnum, pgTable, serial, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import { loan } from "./loans";
import { mortgage } from "./mortgages";
import { staff } from "./staff";

/**
 * New business (owner, 2026-10-10; docs/design/ORIGINATION.md): loan offers with their
 * contract, and mortgage quotes for the tablet. Drafts can be edited; issuing an offer
 * freezes its contract text. Once the game pays the loan out (bank row + phone card) or
 * the tablet sale agreement is pasted, the offer/quote is linked to the record it became.
 */

export const loanOfferKind = pgEnum("loan_offer_kind", ["vehicle", "property", "general"]);
export const loanOfferStatus = pgEnum("loan_offer_status", ["draft", "issued", "funded", "cancelled"]);

export const loanOffer = pgTable(
  "loan_offer",
  {
    id: uuid().primaryKey().defaultRandom(),
    /** Short number staff can say ("offer 12"). */
    number: serial().notNull(),
    kind: loanOfferKind().notNull(),
    status: loanOfferStatus().notNull().default("draft"),
    borrowerStateId: integer().notNull(),
    borrowerName: text().notNull(),
    officerStaffId: uuid()
      .notNull()
      .references(() => staff.id),
    amountCents: bigint({ mode: "number" }).notNull(),
    rateBp: integer().notNull(),
    stateRateBp: integer().notNull(),
    weeks: integer().notNull(),
    /** Contract date; the first payment is a week later. */
    startsOn: timestamp({ withTimezone: true }).notNull(),
    collateral: text(),
    collateralValueCents: bigint({ mode: "number" }),
    purpose: text(),
    weeklyIncomeCents: bigint({ mode: "number" }),
    defaultFeePerDayCents: bigint({ mode: "number" }).notNull(),
    /** Contract terms, copied from settings when the offer is made. */
    purchaseDays: integer().notNull(),
    detailsHours: integer().notNull(),
    extraHours: integer().notNull(),
    defaultAfterDays: integer().notNull(),
    /** What the rate guide suggested, for the record. */
    suggestedRateBp: integer(),
    notes: text().notNull().default(""),
    contractText: text(),
    issuedAt: timestamp({ withTimezone: true }),
    issuedByStaffId: uuid().references(() => staff.id),
    loanId: uuid().references(() => loan.id),
    fundedAt: timestamp({ withTimezone: true }),
    /** Loans someone said this offer is *not* (unlinked by hand); the sync never matches them again. */
    excludedLoanIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    cancelledAt: timestamp({ withTimezone: true }),
    cancelReason: text(),
    createdByStaffId: uuid()
      .notNull()
      .references(() => staff.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("loan_offer_borrower_idx").on(t.borrowerStateId), index("loan_offer_officer_idx").on(t.officerStaffId), index("loan_offer_status_idx").on(t.status)],
);

export const mortgageQuoteStatus = pgEnum("mortgage_quote_status", ["draft", "confirmed", "matched", "cancelled"]);

export const mortgageQuote = pgTable(
  "mortgage_quote",
  {
    id: uuid().primaryKey().defaultRandom(),
    number: serial().notNull(),
    status: mortgageQuoteStatus().notNull().default("draft"),
    buyerStateId: integer().notNull(),
    buyerName: text().notNull(),
    officerStaffId: uuid()
      .notNull()
      .references(() => staff.id),
    address: text().notNull(),
    priceCents: bigint({ mode: "number" }).notNull(),
    agencyCommissionCents: bigint({ mode: "number" }).notNull(),
    /** Percentages in basis points (10% → 1000). */
    downPaymentBp: integer().notNull(),
    termMonths: integer().notNull(),
    fedRateBp: integer().notNull(),
    brokerRateBp: integer().notNull(),
    bankerFeeBp: integer().notNull(),
    primaryResidence: boolean().notNull(),
    /** Litt's lends the money: exempt from the federal maximums (research/17). */
    companyFunded: boolean().notNull().default(false),
    notes: text().notNull().default(""),
    /**
     * Executive approval (research/18): needed when down payment + loan is over the settings line.
     * Cleared when the approved terms change; an executive's own save approves it.
     */
    approvedAt: timestamp({ withTimezone: true }),
    approvedByStaffId: uuid().references(() => staff.id),
    /** When the buyer is expected to sign (set on confirming). */
    expectedSigningAt: timestamp({ withTimezone: true }),
    confirmedAt: timestamp({ withTimezone: true }),
    confirmedByStaffId: uuid().references(() => staff.id),
    signedAt: timestamp({ withTimezone: true }),
    signedByStaffId: uuid().references(() => staff.id),
    mortgageId: uuid().references(() => mortgage.id),
    matchedAt: timestamp({ withTimezone: true }),
    /** Mortgages someone said this quote is *not* (unlinked by hand); the sync never matches them again. */
    excludedMortgageIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    cancelledAt: timestamp({ withTimezone: true }),
    cancelReason: text(),
    createdByStaffId: uuid()
      .notNull()
      .references(() => staff.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("mortgage_quote_buyer_idx").on(t.buyerStateId), index("mortgage_quote_officer_idx").on(t.officerStaffId)],
);

/**
 * Review notes on a quote (research/18): management say what needs changing instead of changing it
 * themselves. Append-only: a note is closed by a second row that `resolves` it (optionally with a reply).
 */
export const mortgageQuoteNote = pgTable(
  "mortgage_quote_note",
  {
    id: uuid().primaryKey().defaultRandom(),
    quoteId: uuid()
      .notNull()
      .references(() => mortgageQuote.id),
    /** Set on the row that marks another note done; its text is the (optional) reply. */
    resolvesId: uuid().references((): AnyPgColumn => mortgageQuoteNote.id),
    staffId: uuid()
      .notNull()
      .references(() => staff.id),
    text: text().notNull(),
    at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("mortgage_quote_note_quote_idx").on(t.quoteId), uniqueIndex("mortgage_quote_note_resolves_uq").on(t.resolvesId)],
);
