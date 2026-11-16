import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { ROLES } from "../../../lib/roles";
import { user } from "./auth";

export const staffRole = pgEnum("staff_role", ROLES);

/**
 * invited   – record exists, invite outstanding, no login yet
 * active    – may sign in
 * suspended – temporarily blocked (sessions revoked); reversible
 * departed  – left the company; kept forever for history and attribution
 */
export const staffStatus = pgEnum("staff_status", ["invited", "active", "suspended", "departed"]);

/**
 * A member of staff = one RP character. Identity in the game is the State ID,
 * which is how bank-export rows and commission payouts are attributed. The
 * login account (`user`) is linked once the invite is accepted.
 */
export const staff = pgTable(
  "staff",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: text().references(() => user.id, { onDelete: "restrict" }),
    stateId: integer().notNull(),
    characterName: text().notNull(),
    role: staffRole().notNull(),
    status: staffStatus().notNull().default("invited"),
    /** Personal bank wallet — learned from commission payouts so later ones match automatically. */
    walletId: text(),
    /**
     * The app tour (docs/design/TUTORIAL-2026-10-12.md): when it was finished or skipped, and
     * for which role — a later, more senior role is offered just what it adds.
     */
    tourCompletedAt: timestamp({ withTimezone: true }),
    tourRole: staffRole(),
    /**
     * The authenticator's 30-second time step of the last code accepted for a step-up (review 2026-10-13): a code
     * already used can't unlock sensitive actions a second time.
     */
    stepUpCounter: bigint({ mode: "number" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    createdByStaffId: uuid(),
  },
  (t) => [
    uniqueIndex("staff_state_id_uq").on(t.stateId),
    uniqueIndex("staff_user_id_uq").on(t.userId),
    uniqueIndex("staff_wallet_uq").on(t.walletId),
    check("staff_state_id_positive", sql`${t.stateId} > 0`),
  ],
);

/**
 * Single-use invite links. Only a SHA-256 of the token is stored, so a database
 * leak does not yield usable links.
 */
export const staffInvite = pgTable(
  "staff_invite",
  {
    id: uuid().primaryKey().defaultRandom(),
    staffId: uuid()
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    tokenHash: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    createdByStaffId: uuid(),
    acceptedAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
  },
  (t) => [uniqueIndex("staff_invite_token_hash_uq").on(t.tokenHash), index("staff_invite_staff_idx").on(t.staffId)],
);

/**
 * One-time password reset links, issued by an executive for someone who has lost
 * their password (there's no email, so no self-service reset). Only the token's
 * hash is stored; their authenticator still guards the account.
 */
export const staffPasswordReset = pgTable(
  "staff_password_reset",
  {
    id: uuid().primaryKey().defaultRandom(),
    staffId: uuid()
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    tokenHash: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Null when issued by the break-glass CLI. */
    createdByStaffId: uuid(),
    usedAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
  },
  (t) => [uniqueIndex("staff_password_reset_token_hash_uq").on(t.tokenHash), index("staff_password_reset_staff_idx").on(t.staffId)],
);
