import { describe, expect, it } from "vitest";
import { can, canManageRole, CAPABILITIES, type Capability } from "./permissions";
import { atLeast, grantableRoles, ROLES, type Role } from "./roles";

/**
 * Executable copy of the SPEC §2 permission matrix. If a capability's minimum
 * role changes, this table must change with it — deliberately.
 */
const MATRIX: Record<Capability, Role[]> = {
  "borrower.lookup": ["loan_officer", "legal", "management", "coo", "ceo", "owner"],
  "loans.originate": ["loan_officer", "legal", "management", "coo", "ceo", "owner"],
  "dashboard.company": ["legal", "management", "coo", "ceo", "owner"],
  "imports.paste": ["loan_officer", "legal", "management", "coo", "ceo", "owner"],
  "loans.view_all": ["legal", "management", "coo", "ceo", "owner"],
  "loans.record_recovery": ["legal", "management", "coo", "ceo", "owner"],
  "loans.edit_metadata": ["management", "coo", "ceo", "owner"],
  "loans.reassign_officer": ["management", "coo", "ceo", "owner"],
  "bank.import": ["management", "coo", "ceo", "owner"],
  "bank.reclassify": ["management", "coo", "ceo", "owner"],
  "allowance.record": ["management", "coo", "ceo", "owner"],
  "loans.charge_off": ["management", "coo", "ceo", "owner"],
  "records.merge": ["management", "coo", "ceo", "owner"],
  "ledger.adjust": ["management", "coo", "ceo", "owner"],
  "finance.view": ["management", "coo", "ceo", "owner"],
  "commissions.view_all": ["management", "coo", "ceo", "owner"],
  "commissions.manage": ["management", "coo", "ceo", "owner"],
  "staff.view": ["management", "coo", "ceo", "owner"],
  "staff.manage": ["management", "coo", "ceo", "owner"],
  "audit.view": ["management", "coo", "ceo", "owner"],
  "settings.manage": ["coo", "ceo", "owner"],
  "mortgages.approve_large": ["coo", "ceo", "owner"],
  "staff.reset_2fa": ["coo", "ceo", "owner"],
  "staff.reset_password": ["coo", "ceo", "owner"],
};

describe("permission matrix (SPEC §2)", () => {
  it("covers every capability", () => {
    expect(Object.keys(MATRIX).sort()).toEqual(Object.keys(CAPABILITIES).sort());
  });

  for (const [capability, allowed] of Object.entries(MATRIX) as [Capability, Role[]][]) {
    for (const role of ROLES) {
      const expected = allowed.includes(role);
      it(`${role} ${expected ? "can" : "cannot"} ${capability}`, () => {
        expect(can(role, capability)).toBe(expected);
      });
    }
  }
});

describe("role hierarchy", () => {
  it("treats CEO and COO as peers", () => {
    expect(atLeast("ceo", "coo")).toBe(true);
    expect(atLeast("coo", "ceo")).toBe(true);
  });

  it("only lets the Owner grant executive roles", () => {
    expect(grantableRoles("owner")).toEqual([...ROLES]);
    expect(grantableRoles("ceo")).toEqual(["management", "legal", "loan_officer"]);
    expect(grantableRoles("coo")).toEqual(["management", "legal", "loan_officer"]);
    expect(grantableRoles("management")).toEqual(["legal", "loan_officer"]);
  });

  it("gives Legal and Officers no staff management", () => {
    expect(grantableRoles("legal")).toEqual([]);
    expect(grantableRoles("loan_officer")).toEqual([]);
  });

  it("never lets anyone manage a peer or a superior (except the Owner)", () => {
    for (const actor of ROLES) {
      if (actor === "owner") continue;
      for (const target of ROLES) {
        if (atLeast(target, actor)) expect(canManageRole(actor, target), `${actor} → ${target}`).toBe(false);
      }
    }
  });
});
