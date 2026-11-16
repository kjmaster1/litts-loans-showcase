import { describe, expect, it } from "vitest";
import { ROLES, type Role } from "@/lib/roles";
import { canActOnOffer, canActOnQuote, canAnnotateLoan, canApproveQuote, canReviewQuote, canAssignOfficer, canBeOfficer, canCloseCase, canCollectOn, canHandToLegal, canSeeLoan, canSeeMortgage, SERVER_AGGREGATE, viewerOf } from "./rules";
import type { Viewer } from "./viewer";

const viewer = (role: Role): Viewer => ({
  staffId: `staff-${role}`,
  userId: "u",
  sessionId: "s",
  role,
  characterName: role,
  stateId: 1,
  username: role,
  twoFactorEnabled: true,
  stepUpAt: null,
  tourCompletedAt: null,
  tourRole: null,
});
const mine = (role: Role) => ({ officerStaffId: `staff-${role}` });
const someoneElse = { officerStaffId: "staff-colleague" };
const nobody = { officerStaffId: null };

/** Which roles get each rule on a colleague's record (their own always counts, see below). */
const ON_OTHERS: Record<string, Role[]> = {
  canSeeLoan: ["legal", "management", "coo", "ceo", "owner"],
  canSeeMortgage: ["legal", "management", "coo", "ceo", "owner"],
  canCollectOn: ["legal", "management", "coo", "ceo", "owner"],
  canActOnOffer: ["management", "coo", "ceo", "owner"],
  canActOnQuote: ["management", "coo", "ceo", "owner"],
  canAnnotateLoan: ["legal", "management", "coo", "ceo", "owner"],
  // Legal cases (owner, 2026-11-10): the owner, management and the loan's own officer hand a case to Legal.
  canHandToLegal: ["management", "coo", "ceo", "owner"],
};
const RULES = { canSeeLoan, canSeeMortgage, canCollectOn, canActOnOffer, canActOnQuote, canAnnotateLoan, canHandToLegal };

describe("closing a legal case", () => {
  it("is for management and executives", () => {
    expect(ROLES.filter((r) => canCloseCase(viewer(r))).sort()).toEqual(["ceo", "coo", "management", "owner"]);
  });
});

describe("record-level rules (one place)", () => {
  for (const [name, rule] of Object.entries(RULES)) {
    it(`${name}: a colleague's record`, () => {
      expect(ROLES.filter((r) => rule(viewer(r), someoneElse))).toEqual(expect.arrayContaining(ON_OTHERS[name]));
      expect(ROLES.filter((r) => rule(viewer(r), someoneElse)).sort()).toEqual([...ON_OTHERS[name]].sort());
    });
    it(`${name}: everyone may act on their own record`, () => {
      for (const r of ROLES) expect(rule(viewer(r), mine(r)), r).toBe(true);
    });
  }

  it("an unassigned record is nobody's own", () => {
    expect(canSeeLoan(viewer("loan_officer"), nobody)).toBe(false);
    expect(canCollectOn(viewer("loan_officer"), nobody)).toBe(false);
    expect(canSeeLoan(viewer("legal"), nobody)).toBe(true);
  });

  it("officers: management sets anyone; an officer only claims an unassigned record for themselves", () => {
    const officer = viewer("loan_officer");
    expect(canAssignOfficer(officer, nobody, officer.staffId)).toBe(true);
    expect(canAssignOfficer(officer, nobody, "staff-colleague")).toBe(false);
    expect(canAssignOfficer(officer, someoneElse, officer.staffId)).toBe(false);
    expect(canAssignOfficer(officer, mine("loan_officer"), null)).toBe(false);
    expect(ROLES.filter((r) => canAssignOfficer(viewer(r), someoneElse, null)).sort()).toEqual(["ceo", "coo", "management", "owner"]);
  });

  it("the Legal Team (the outside lawyer) is never an officer, not even by claiming a record", () => {
    expect(ROLES.filter((r) => !canBeOfficer({ role: r }))).toEqual(["legal"]);
    const lawyer = viewer("legal");
    expect(canAssignOfficer(lawyer, nobody, lawyer.staffId)).toBe(false);
  });

  it("quote review: management note a colleague's quote, not their own; executives approve", () => {
    expect(ROLES.filter((r) => canReviewQuote(viewer(r), someoneElse)).sort()).toEqual(["ceo", "coo", "management", "owner"]);
    for (const r of ROLES) expect(canReviewQuote(viewer(r), mine(r)), r).toBe(false);
    expect(ROLES.filter((r) => canApproveQuote(viewer(r))).sort()).toEqual(["ceo", "coo", "owner"]);
  });

  it("server-side aggregates are marked explicitly, never with a missing viewer", () => {
    expect(viewerOf(SERVER_AGGREGATE)).toBeNull();
    const v = viewer("loan_officer");
    expect(viewerOf(v)).toBe(v);
  });
});
