import { atLeast, grantableRoles, isExecutive, type Role } from "@/lib/roles";

/**
 * Single source of truth for "who may do what" (SPEC §2). Every Server Action,
 * Route Handler and data-access function checks one of these before touching
 * data; the UI uses the same functions only to decide what to show.
 *
 * Resource-level rules (e.g. an officer viewing only their own loans) are
 * expressed as functions taking the resource's owner, added per module.
 */
export const CAPABILITIES = {
  "borrower.lookup": "loan_officer",
  "loans.originate": "loan_officer",
  /** The company dashboard; loan officers land on My work instead (owner, 2026-10-11). */
  "dashboard.company": "legal",
  "loans.view_all": "legal",
  "imports.paste": "loan_officer",
  "loans.record_recovery": "legal",
  "loans.edit_metadata": "management",
  "loans.reassign_officer": "management",
  "bank.import": "management",
  "bank.reclassify": "management",
  "allowance.record": "management",
  "loans.charge_off": "management",
  /** Retire a duplicate or mistaken loan/mortgage record (merge it into the real one, or remove a card-only loan). */
  "records.merge": "management",
  "ledger.adjust": "management",
  "finance.view": "management",
  "commissions.view_all": "management",
  "commissions.manage": "management",
  "staff.view": "management",
  "staff.manage": "management",
  "audit.view": "management",
  "settings.manage": "ceo",
  /** Approve a mortgage whose down payment + loan is over the executive-approval line (owner, 2026-10-15). */
  "mortgages.approve_large": "ceo",
  "staff.reset_2fa": "ceo",
  "staff.reset_password": "ceo",
} as const satisfies Record<string, Role>;

export type Capability = keyof typeof CAPABILITIES;

/** Capabilities that require a fresh step-up and a written reason (ADR 0002). */
export const SENSITIVE: ReadonlySet<Capability> = new Set<Capability>([
  "loans.charge_off",
  "records.merge",
  "ledger.adjust",
  "settings.manage",
  "staff.reset_2fa",
  "staff.reset_password",
]);

export function can(role: Role, capability: Capability): boolean {
  const minimum: Role = CAPABILITIES[capability];
  // CEO and COO share a rank, so "ceo" as a minimum means "any executive".
  return minimum === "ceo" ? isExecutive(role) : atLeast(role, minimum);
}

/** Whether `actor` may create, change or deactivate a staff member holding `targetRole`. */
export function canManageRole(actor: Role, targetRole: Role): boolean {
  return can(actor, "staff.manage") && grantableRoles(actor).includes(targetRole);
}

export class ForbiddenError extends Error {
  constructor(message = "You do not have permission to do that.") {
    super(message);
    this.name = "ForbiddenError";
  }
}
