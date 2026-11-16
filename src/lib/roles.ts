/**
 * Company role hierarchy (SPEC §2): Owner → CEO & COO → Management → Legal Team →
 * Loan Officer. Pure module — safe to import from client components for display.
 */
export const ROLES = ["owner", "ceo", "coo", "management", "legal", "loan_officer"] as const;
export type Role = (typeof ROLES)[number];

/** CEO and COO share a rank: neither outranks the other. */
const RANK: Record<Role, number> = {
  owner: 100,
  ceo: 90,
  coo: 90,
  management: 70,
  legal: 50,
  loan_officer: 30,
};

export const ROLE_LABEL: Record<Role, string> = {
  owner: "Owner",
  ceo: "CEO",
  coo: "COO",
  management: "Management",
  legal: "Legal Team",
  loan_officer: "Loan Officer",
};

export function rankOf(role: Role): number {
  return RANK[role];
}

/** True when `role` is at least as senior as `minimum`. */
export function atLeast(role: Role, minimum: Role): boolean {
  return RANK[role] >= RANK[minimum];
}

/** Executives: Owner, CEO, COO. */
export function isExecutive(role: Role): boolean {
  return atLeast(role, "ceo");
}

/**
 * Roles an actor may grant or manage: strictly below their own rank, and only
 * down to the floor their tier allows (Management may manage up to Legal,
 * CEO/COO up to Management, Owner everything). See SPEC §2.
 */
export function grantableRoles(actor: Role): Role[] {
  if (actor === "owner") return [...ROLES];
  return ROLES.filter((r) => RANK[r] < RANK[actor] && atLeast(actor, "management"));
}

/**
 * Staff who can be credited with work — loan and mortgage officers, wallets,
 * commission. Invited staff count before they accept (owner, 2026-10-10); only
 * signing in needs an accepted invite ("active"). Suspended/departed never count.
 */
export const WORKING_STATUSES = ["active", "invited"] as const;
export const isWorkingStatus = (status: string) => (WORKING_STATUSES as readonly string[]).includes(status);

/**
 * Finished loans and mortgages (completed / written off) are a matter of record:
 * anyone who worked here can be named as their officer, departed or suspended
 * staff included (owner, 2026-10-10). Open ones need working staff.
 */
export const RECORD_STATUSES = ["active", "invited", "suspended", "departed"] as const;

const STATUS_NOTE: Record<string, string> = { invited: "invite pending", suspended: "suspended", departed: "departed" };
/** "Name (departed)" etc. for pickers; plain name for active staff. */
export const staffOptionLabel = (name: string, status: string) => (STATUS_NOTE[status] ? `${name} (${STATUS_NOTE[status]})` : name);
