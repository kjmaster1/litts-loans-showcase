import { bigint, boolean, index, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { bankTransaction, journalEntry } from "./ledger";
import { staff } from "./staff";

/** See docs/design/COMMISSIONS.md. */

export const commissionWeekStatus = pgEnum("commission_week_status", ["open", "closed"]);

/** One pay week (Monday 00:00 London). Created when its roster is first saved or it is closed. */
export const commissionWeek = pgTable(
  "commission_week",
  {
    id: uuid().primaryKey().defaultRandom(),
    /** Monday's calendar date, e.g. "2026-10-12". */
    weekKey: text().notNull(),
    status: commissionWeekStatus().notNull().default("open"),
    rosterLockedAt: timestamp({ withTimezone: true }),
    rosterLockedByStaffId: uuid().references(() => staff.id),
    closedAt: timestamp({ withTimezone: true }),
    closedByStaffId: uuid().references(() => staff.id),
    entryId: uuid().references(() => journalEntry.id),
    /** Snapshot at close: pool total, remainder, company share, rates. */
    summary: jsonb().$type<Record<string, unknown>>(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("commission_week_key_uq").on(t.weekKey)],
);

/** Who's in the week's mortgage pool, with the activity evidence the app suggested it from. */
export const commissionRoster = pgTable(
  "commission_roster",
  {
    weekId: uuid()
      .notNull()
      .references(() => commissionWeek.id),
    staffId: uuid()
      .notNull()
      .references(() => staff.id),
    included: boolean().notNull(),
    suggested: boolean().notNull(),
    evidence: jsonb().$type<Record<string, number>>().notNull().default({}),
    decidedByStaffId: uuid().references(() => staff.id),
    decidedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.weekId, t.staffId] })],
);

/** Lines frozen when a week is closed. */
export const commissionLine = pgTable(
  "commission_line",
  {
    id: uuid().primaryKey().defaultRandom(),
    weekId: uuid()
      .notNull()
      .references(() => commissionWeek.id),
    staffId: uuid()
      .notNull()
      .references(() => staff.id),
    kind: text().notNull(),
    label: text().notNull(),
    baseCents: bigint({ mode: "number" }).notNull(),
    amountCents: bigint({ mode: "number" }).notNull(),
    sourceTxId: uuid().references(() => bankTransaction.id),
    loanId: uuid(),
    mortgageId: uuid(),
  },
  (t) => [index("commission_line_week_idx").on(t.weekId), index("commission_line_staff_idx").on(t.staffId)],
);

/** Whole-dollar amount each person earned in a closed week (what 2000 owes them). */
export const commissionAward = pgTable(
  "commission_award",
  {
    weekId: uuid()
      .notNull()
      .references(() => commissionWeek.id),
    staffId: uuid()
      .notNull()
      .references(() => staff.id),
    amountCents: bigint({ mode: "number" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.weekId, t.staffId] })],
);

export const payoutStatus = pgEnum("commission_payout_status", ["unmatched", "matched", "old_scheme"]);

/** "Employee Pay: Commission Pay: …" rows after the scheme started. */
export const commissionPayout = pgTable(
  "commission_payout",
  {
    bankTransactionId: uuid()
      .primaryKey()
      .references(() => bankTransaction.id),
    status: payoutStatus().notNull().default("unmatched"),
    staffId: uuid().references(() => staff.id),
    /** The Dr 2000 / Cr 5000 entry moving a matched payout from expense to settling what's owed. */
    entryId: uuid().references(() => journalEntry.id),
    matchedBy: text(),
    decidedByStaffId: uuid().references(() => staff.id),
    decidedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index("commission_payout_staff_idx").on(t.staffId)],
);
