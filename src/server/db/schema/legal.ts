import { sql } from "drizzle-orm";
import { bigint, bigserial, check, index, jsonb, pgTable, serial, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { bankTransaction } from "./ledger";
import { loan } from "./loans";
import { staff } from "./staff";

/**
 * Legal cases (owner, 2026-11-10; docs/superpowers/specs/2026-11-10-legal-case-sheets-design.md): a defaulted loan's
 * case sheet for the lawyer. The case's state is derived (Needs details / Ready / With Legal / Closed); this row only
 * holds what people did to it. Created by the first action on the loan's case.
 */
export const legalCase = pgTable(
  "legal_case",
  {
    id: uuid().primaryKey().defaultRandom(),
    /** Short reference staff and the fee comment use ("#LC12"). */
    number: serial().notNull(),
    loanId: uuid()
      .notNull()
      .references(() => loan.id),
    /** A default date set by hand (an odd case); otherwise derived from the cards. */
    defaultAtOverride: timestamp({ withTimezone: true }),
    detailsRequestedAt: timestamp({ withTimezone: true }),
    detailsRequestedByStaffId: uuid().references(() => staff.id),
    contractSharedAt: timestamp({ withTimezone: true }),
    contractSharedByStaffId: uuid().references(() => staff.id),
    closedAt: timestamp({ withTimezone: true }),
    closedByStaffId: uuid().references(() => staff.id),
    closeNote: text(),
    /**
     * A note for Legal (2026-11-10): the weekly payment the signed contract states, when an officer's paper differs from
     * the game, and why. The sheet still claims the phone card's amount.
     */
    contractInstalmentCents: bigint({ mode: "number" }),
    contractInstalmentReason: text(),
    contractInstalmentByStaffId: uuid().references(() => staff.id),
    contractInstalmentAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("legal_case_loan_uq").on(t.loanId),
    uniqueIndex("legal_case_number_uq").on(t.number),
    check("legal_case_contract_instalment_positive", sql`${t.contractInstalmentCents} is null or ${t.contractInstalmentCents} > 0`),
  ],
);

/**
 * What was handed to Legal, frozen (append-only). The newest row per case is the current hand-over; a later one
 * (management, with a reason) replaces it without changing it.
 */
export const legalCaseHandover = pgTable(
  "legal_case_handover",
  {
    id: uuid().primaryKey().defaultRandom(),
    caseId: uuid()
      .notNull()
      .references(() => legalCase.id),
    handedAt: timestamp({ withTimezone: true }).notNull(),
    handedByStaffId: uuid()
      .notNull()
      .references(() => staff.id),
    /** The Legal Team member the attorney & filing fee is paid to. */
    payeeStaffId: uuid()
      .notNull()
      .references(() => staff.id),
    feeCents: bigint({ mode: "number" }).notNull(),
    /** The figures (`CaseSheet`, domain/legal/case-sheet.ts) and the text exactly as handed over. */
    sheet: jsonb().notNull(),
    text: text().notNull(),
    /** Why it was handed over again; null on the first hand-over. */
    reason: text(),
  },
  (t) => [index("legal_case_handover_case_idx").on(t.caseId, t.handedAt)],
);

/**
 * Attorney & filing fee payments (bank `pay` rows) linked to their case, as a history (append-only): `link` rows by the
 * sync (`reference`, the #LC number) or a person (`confirmed`); an `unlink` row (management, with a reason) undoes a wrong
 * one. A payment's newest row says where it stands; one with any history is never linked again by the sync.
 */
export const legalFeeLink = pgTable(
  "legal_fee_link",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    bankTransactionId: uuid()
      .notNull()
      .references(() => bankTransaction.id),
    caseId: uuid()
      .notNull()
      .references(() => legalCase.id),
    /** `link` or `unlink`. */
    action: text().notNull(),
    /** For a link: `reference` or `confirmed`. */
    method: text(),
    reason: text(),
    staffId: uuid().references(() => staff.id),
    at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("legal_fee_link_tx_idx").on(t.bankTransactionId, t.id), index("legal_fee_link_case_idx").on(t.caseId)],
);
