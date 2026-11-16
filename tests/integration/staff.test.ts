import { and, desc, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { totp } from "../support/totp";

vi.mock("@/server/request", () => ({ getRequestMeta: async () => ({ ip: "203.0.113.10", userAgent: "vitest" }) }));

const { auth } = await import("@/server/auth/auth");
const { symmetricEncrypt } = await import("better-auth/crypto");
const { base32 } = await import("@better-auth/utils/base32");
const { withInviteContext } = await import("@/server/auth/invite-context");
const { verifyStepUp } = await import("@/server/auth/step-up");
const svc = await import("@/server/staff/service");
const { completeInvite, createInvite, findPendingInvite, placeholderEmail } = await import("@/server/staff/invites");
const { db } = await import("@/server/db");
const { auditEvent, session, staff, staffInvite, twoFactor, user } = await import("@/server/db/schema");
const { resetDb } = await import("../support/db");

type Viewer = import("@/server/authz/viewer").Viewer;
type Role = Viewer["role"];

/** Staff management and step-up (review 2026-10-13: both were thinly tested). */

async function onboard(username: string, stateId: number, role: Role = "loan_officer") {
  const { token } = await createInvite({ stateId, characterName: `Test ${username}`, role, actor: { type: "system" } });
  const invite = (await findPendingInvite(token))!;
  await withInviteContext(invite.inviteId, () =>
    auth.api.signUpEmail({ body: { email: placeholderEmail(invite.staffId), password: "correct horse battery staple", name: invite.characterName, username } }),
  );
  const u = (await db.query.user.findFirst({ where: eq(user.username, username) }))!;
  await completeInvite({ invite, userId: u.id });
  return { userId: u.id, staffId: invite.staffId };
}

const viewerOf = (p: { userId: string; staffId: string }, role: Role, sessionId = `s-${p.staffId}`): Viewer => ({
  staffId: p.staffId,
  userId: p.userId,
  sessionId,
  role,
  characterName: "Tester",
  stateId: 1,
  username: "tester",
  twoFactorEnabled: true,
  stepUpAt: null,
  tourCompletedAt: null,
  tourRole: null,
});

async function addSession(userId: string) {
  const id = crypto.randomUUID();
  await db.insert(session).values({ id, token: crypto.randomUUID(), userId, expiresAt: new Date(Date.now() + 3_600_000), updatedAt: new Date() });
  return id;
}

const sessionsOf = async (userId: string) => db.select().from(session).where(eq(session.userId, userId));
const lastAudit = async (action: string) => (await db.select().from(auditEvent).where(eq(auditEvent.action, action)).orderBy(desc(auditEvent.id)).limit(1))[0];

let ceo: Viewer;
let manager: Viewer;

beforeAll(async () => {
  await resetDb();
  ceo = viewerOf(await onboard("the.ceo", 61001, "ceo"), "ceo");
  manager = viewerOf(await onboard("a.manager", 61002, "management"), "management");
});

describe("inviting and listing", () => {
  it("invites only to roles below the inviter", async () => {
    await expect(svc.inviteStaff(manager, { stateId: 61010, characterName: "Peer Manager", role: "management" })).rejects.toThrow(/can't invite/);
    await expect(svc.inviteStaff(ceo, { stateId: 61011, characterName: "Second CEO", role: "coo" })).rejects.toThrow(/can't invite/);
    const { url, expiresAt } = await svc.inviteStaff(manager, { stateId: 61012, characterName: "New Officer", role: "loan_officer" });
    expect(url).toMatch(/\/invite\/[A-Za-z0-9_-]+$/);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("re-issues an invite only while it's pending", async () => {
    const [invited] = await db.select().from(staff).where(eq(staff.stateId, 61012));
    const again = await svc.reissueInvite(manager, invited.id);
    expect(again.url).toMatch(/\/invite\//);
    const open = await db.select().from(staffInvite).where(and(eq(staffInvite.staffId, invited.id)));
    expect(open.filter((i) => !i.revokedAt && !i.acceptedAt)).toHaveLength(1); // the first link was replaced
    await expect(svc.reissueInvite(ceo, manager.staffId)).rejects.toThrow(/already accepted/);
  });

  it("lists everyone, most senior first, marking who the viewer may change", async () => {
    const rows = await svc.listStaff(manager);
    expect(rows[0].role).toBe("ceo");
    expect(rows.find((r) => r.id === ceo.staffId)?.manageable).toBe(false);
    expect(rows.find((r) => r.id === manager.staffId)?.manageable).toBe(false); // not themselves
    expect(rows.find((r) => r.stateId === 61012)).toMatchObject({ status: "invited", manageable: true });
    expect(await svc.staffCounts()).toMatchObject({ active: 2, invited: 1 });
    expect((await svc.searchStaff("manager")).map((s) => s.stateId)).toContain(61002);
    expect((await svc.searchStaff("61001")).map((s) => s.stateId)).toEqual([61001]);
    expect(await svc.searchStaff("9999999999")).toEqual([]);
  });
});

describe("changing roles and status", () => {
  it("changes a role within the actor's reach, and audits it", async () => {
    const officer = await onboard("role.change", 61020);
    await expect(svc.changeRole(manager, manager.staffId, "legal")).rejects.toThrow(/your own account/);
    await expect(svc.changeRole(manager, ceo.staffId, "legal")).rejects.toThrow(/permission/);
    await expect(svc.changeRole(manager, officer.staffId, "management")).rejects.toThrow(/can't assign/);
    await svc.changeRole(manager, officer.staffId, "legal");
    const [row] = await db.select().from(staff).where(eq(staff.id, officer.staffId));
    expect(row.role).toBe("legal");
    expect(await lastAudit("staff.role.changed")).toMatchObject({ targetId: officer.staffId, metadata: expect.objectContaining({ from: "loan_officer", to: "legal" }) });
  });

  it("changes a name (the character was renamed in the game) for the staff record and sign-in account, and audits it", async () => {
    const officer = await onboard("name.change", 61022);
    await expect(svc.changeName(manager, manager.staffId, "Someone Else")).rejects.toThrow(/your own account/);
    await expect(svc.changeName(manager, ceo.staffId, "Someone Else")).rejects.toThrow(/permission/);
    await svc.changeName(manager, officer.staffId, "Cove Berry");
    const [row] = await db.select().from(staff).where(eq(staff.id, officer.staffId));
    expect(row).toMatchObject({ characterName: "Cove Berry", stateId: 61022 });
    const [account] = await db.select().from(user).where(eq(user.id, officer.userId));
    expect(account).toMatchObject({ name: "Cove Berry", username: "name.change" });
    expect(await lastAudit("staff.name.changed")).toMatchObject({
      targetId: officer.staffId,
      metadata: expect.objectContaining({ from: "Test name.change", to: "Cove Berry", stateId: 61022 }),
    });
    expect((await svc.searchStaff("berry")).map((s) => s.stateId)).toEqual([61022]);
  });

  it("suspending signs them out everywhere; reactivating lets them back", async () => {
    const officer = await onboard("to.suspend", 61021);
    await addSession(officer.userId);
    await addSession(officer.userId);
    await svc.changeStatus(manager, officer.staffId, "suspend", "Investigating a complaint");
    expect(await sessionsOf(officer.userId)).toHaveLength(0);
    expect(await lastAudit("staff.suspended")).toMatchObject({ reason: "Investigating a complaint", metadata: expect.objectContaining({ sessionsRevoked: 2 }) });
    await expect(svc.changeStatus(manager, officer.staffId, "suspend", "Again")).rejects.toThrow(/Can't suspend someone who is suspended/);
    await svc.changeStatus(manager, officer.staffId, "reactivate", "Cleared");
    const [row] = await db.select().from(staff).where(eq(staff.id, officer.staffId));
    expect(row.status).toBe("active");
  });

  it("marking an invited person departed withdraws their invite", async () => {
    const [invited] = await db.select().from(staff).where(eq(staff.stateId, 61012));
    await svc.changeStatus(manager, invited.id, "depart", "Never started");
    const open = (await db.select().from(staffInvite).where(eq(staffInvite.staffId, invited.id))).filter((i) => !i.revokedAt && !i.acceptedAt);
    expect(open).toHaveLength(0);
    await expect(svc.changeStatus(manager, invited.id, "reactivate", "Back")).rejects.toThrow(/Can't reactivate/);
  });
});

describe("step-up", () => {
  const SECRET = "review-2026-10-13-step-up-secret";
  const code = (offset = 0) => totp(base32.encode(SECRET, { padding: false }), offset);
  let person: Viewer;

  beforeAll(async () => {
    const p = await onboard("steps.up", 61030, "management");
    person = viewerOf(p, "management", await addSession(p.userId));
    const ctx = await auth.$context;
    await db.insert(twoFactor).values({ id: crypto.randomUUID(), userId: p.userId, secret: await symmetricEncrypt({ key: ctx.secretConfig, data: SECRET }), backupCodes: "x" });
  });

  it("accepts a current code once, and refuses the same code again", async () => {
    const { until } = await verifyStepUp(person, code());
    expect(until.getTime()).toBeGreaterThan(Date.now());
    const [s] = await db.select().from(session).where(eq(session.id, person.sessionId));
    expect(s.stepUpAt).not.toBeNull();
    await expect(verifyStepUp(person, code())).rejects.toThrow(/already used/);
    expect((await lastAudit("auth.step_up.failed")).metadata).toMatchObject({ reason: "code_already_used" });
  });

  it("counts every wrong code sent at once towards the lockout", async () => {
    await db.update(twoFactor).set({ failedVerificationCount: 0, lockedUntil: null }).where(eq(twoFactor.userId, person.userId));
    const wrong = ["000000", "111111", "222222", "333333", "444444", "555555", "666666", "777777"].filter((c) => ![code(-1), code(), code(1)].includes(c));
    const results = await Promise.allSettled(wrong.map((c) => verifyStepUp(person, c)));
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    const [tf] = await db.select().from(twoFactor).where(eq(twoFactor.userId, person.userId));
    expect(tf.failedVerificationCount).toBe(5); // the rest were turned away by the lock, not counted as one
    expect(tf.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    await expect(verifyStepUp(person, code(1))).rejects.toThrow(/Too many wrong codes/);
  });

  it("rejects anything that isn't six digits", async () => {
    await expect(verifyStepUp(person, "12345")).rejects.toThrow(/6-digit/);
  });
});
