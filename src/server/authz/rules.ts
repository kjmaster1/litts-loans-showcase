import { eq, type AnyColumn, type SQL } from "drizzle-orm";
import { can } from "@/lib/permissions";
import type { Role } from "@/lib/roles";
import type { Viewer } from "./viewer";

/**
 * Record-level access rules, in one place (owner review 2026-10-11 — they had spread over five
 * modules and two pages). `can(role, capability)` says what a role may do at all; these say
 * *which records*. Every page, action and query uses these, never its own comparison.
 *
 * - Loans and mortgages: the officer sees their own; `loans.view_all` (Legal and up) sees all.
 * - Offers and quotes: everyone who originates sees all (owner, 2026-10-11); only the officer
 *   who made one, or `loans.reassign_officer` (management), changes it.
 * - Collections, collateral and notes: the record's officer, or `loans.record_recovery` (Legal and up).
 * - Quote review (research/18): management leave notes on a colleague's quote; executives approve large ones.
 * - Officers: management sets anyone; a loan officer may claim an unassigned record for themselves (owner, 2026-10-13).
 */

type Owned = { officerStaffId: string | null };

const own = (v: Viewer, r: Owned) => r.officerStaffId !== null && r.officerStaffId === v.staffId;

export const canSeeLoan = (v: Viewer, l: Owned): boolean => can(v.role, "loans.view_all") || own(v, l);
export const canSeeMortgage = (v: Viewer, m: Owned): boolean => can(v.role, "loans.view_all") || own(v, m);

/** Hand a defaulted loan's case to Legal, or correct its default date: the owner, management, or the loan's own officer (owner, 2026-11-10). */
export const canHandToLegal = (v: Viewer, l: Owned): boolean => can(v.role, "loans.reassign_officer") || own(v, l);
/** Close a legal case, or hand one over again: management and executives. */
export const canCloseCase = (v: Viewer): boolean => can(v.role, "loans.reassign_officer");

/** Log collections actions on a loan or mortgage. */
export const canCollectOn = (v: Viewer, r: Owned): boolean => can(v.role, "loans.record_recovery") || own(v, r);

/** Record collateral or a note on a loan: the same people who chase it. */
export const canAnnotateLoan = canCollectOn;

/**
 * Who may be a loan's, mortgage's, offer's or quote's officer (and so earn its commission). Not the Legal Team: that's
 * the outside lawyer (owner, 2026-11-10). Every place that sets an officer checks this.
 */
export const canBeOfficer = (s: { role: Role }): boolean => s.role !== "legal";
export const NOT_OFFICER_MESSAGE = "The Legal Team can’t be a loan’s or mortgage’s officer.";

/** Set a loan's or mortgage's officer to `to` (null = unassign). */
export const canAssignOfficer = (v: Viewer, r: Owned, to: string | null): boolean =>
  can(v.role, "loans.reassign_officer") || (to !== null && to === v.staffId && r.officerStaffId === null && canBeOfficer(v));

/** Edit, issue, cancel, link or unlink a loan offer. */
export const canActOnOffer = (v: Viewer, o: Owned): boolean => can(v.role, "loans.originate") && (own(v, o) || can(v.role, "loans.reassign_officer"));
/** Edit, cancel, link or unlink a mortgage quote. */
export const canActOnQuote = (v: Viewer, q: Owned): boolean => can(v.role, "loans.originate") && (own(v, q) || can(v.role, "loans.reassign_officer"));
/** Leave a review note on a quote: management, on someone else's (they'd just change their own). */
export const canReviewQuote = (v: Viewer, q: Owned): boolean => can(v.role, "loans.reassign_officer") && !own(v, q);
/** Approve a quote over the executive-approval line: executives (their own are approved when they save them). */
export const canApproveQuote = (v: Viewer): boolean => can(v.role, "mortgages.approve_large");

/** The SQL filter matching `canSeeLoan`/`canSeeMortgage` for list queries (no filter for view_all). */
export const officerScope = (v: Viewer, officerColumn: AnyColumn): SQL | undefined => (can(v.role, "loans.view_all") ? undefined : eq(officerColumn, v.staffId));

/**
 * Passed *instead of* a viewer when a server-side aggregate needs every row — risk, the
 * lending check, the borrower directory, the forecast. Rows fetched this way are never listed
 * to a viewer; the explicit marker makes each such call easy to find and review.
 */
export const SERVER_AGGREGATE: unique symbol = Symbol("server-aggregate");
export type ListScope = Viewer | typeof SERVER_AGGREGATE;
export const viewerOf = (scope: ListScope): Viewer | null => (scope === SERVER_AGGREGATE ? null : scope);
