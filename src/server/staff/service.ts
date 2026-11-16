import "server-only";
import { and, asc, eq, ilike, isNull, max, sql } from "drizzle-orm";
import { can, canManageRole, ForbiddenError } from "@/lib/permissions";
import { asStateId, cleanSearch, likeEscape } from "@/lib/search";
import { ROLES, rankOf, type Role } from "@/lib/roles";
import { recordAudit } from "@/server/audit/audit";
import { requireFreshStepUp } from "@/server/auth/step-up-guard";
import type { Viewer } from "@/server/authz/viewer";
import { db } from "@/server/db";
import { passkey, session, staff, staffInvite, twoFactor, user } from "@/server/db/schema";
import { env } from "@/server/env";
import { getRequestMeta } from "@/server/request";
import { createInvite } from "./invites";

export type StaffRow = {
  id: string;
  characterName: string;
  stateId: number;
  role: Role;
  status: "invited" | "active" | "suspended" | "departed";
  username: string | null;
  twoFactorEnabled: boolean;
  lastActiveAt: Date | null;
  inviteExpiresAt: Date | null;
  createdAt: Date;
  /** Whether the current viewer may change this member. */
  manageable: boolean;
};

/** Staff directory, most senior first. Caller must hold `staff.view`. */
export async function listStaff(viewer: Viewer): Promise<StaffRow[]> {
  const lastActive = db
    .select({ userId: session.userId, at: max(session.updatedAt).as("at") })
    .from(session)
    .groupBy(session.userId)
    .as("last_active");
  const pendingInvite = db
    .select({ staffId: staffInvite.staffId, expiresAt: max(staffInvite.expiresAt).as("expires_at") })
    .from(staffInvite)
    .where(and(isNull(staffInvite.acceptedAt), isNull(staffInvite.revokedAt)))
    .groupBy(staffInvite.staffId)
    .as("pending_invite");

  const rows = await db
    .select({
      id: staff.id,
      characterName: staff.characterName,
      stateId: staff.stateId,
      role: staff.role,
      status: staff.status,
      username: user.username,
      twoFactorEnabled: user.twoFactorEnabled,
      lastActiveAt: lastActive.at,
      inviteExpiresAt: pendingInvite.expiresAt,
      createdAt: staff.createdAt,
    })
    .from(staff)
    .leftJoin(user, eq(user.id, staff.userId))
    .leftJoin(lastActive, eq(lastActive.userId, staff.userId))
    .leftJoin(pendingInvite, eq(pendingInvite.staffId, staff.id))
    .orderBy(asc(staff.characterName));

  return rows
    .map((r) => ({
      ...r,
      twoFactorEnabled: Boolean(r.twoFactorEnabled),
      manageable: r.id !== viewer.staffId && canManageRole(viewer.role, r.role),
    }))
    .sort((a, b) => rankOf(b.role) - rankOf(a.role) || ROLES.indexOf(a.role) - ROLES.indexOf(b.role));
}

export function inviteUrl(token: string): string {
  return new URL(`/invite/${token}`, env.BETTER_AUTH_URL).toString();
}

export async function inviteStaff(
  viewer: Viewer,
  input: { stateId: number; characterName: string; role: Role },
): Promise<{ url: string; expiresAt: Date }> {
  if (!canManageRole(viewer.role, input.role)) throw new ForbiddenError("You can't invite someone to that role.");
  const { token, expiresAt } = await createInvite({
    ...input,
    actor: { type: "staff", staffId: viewer.staffId },
    request: await getRequestMeta(),
  });
  return { url: inviteUrl(token), expiresAt };
}

export async function loadManageable(viewer: Viewer, staffId: string) {
  const target = await db.query.staff.findFirst({ where: eq(staff.id, staffId) });
  if (!target) throw new ForbiddenError("Staff member not found.");
  if (target.id === viewer.staffId) throw new ForbiddenError("You can't change your own account here.");
  if (!canManageRole(viewer.role, target.role)) throw new ForbiddenError();
  return target;
}

export async function reissueInvite(viewer: Viewer, staffId: string): Promise<{ url: string; expiresAt: Date }> {
  const target = await loadManageable(viewer, staffId);
  if (target.status !== "invited") throw new ForbiddenError("This person has already accepted their invite.");
  return inviteStaff(viewer, { stateId: target.stateId, characterName: target.characterName, role: target.role });
}

export async function changeRole(viewer: Viewer, staffId: string, role: Role): Promise<void> {
  const target = await loadManageable(viewer, staffId);
  if (!canManageRole(viewer.role, role)) throw new ForbiddenError("You can't assign that role.");
  if (target.role === role) return;
  const request = await getRequestMeta();
  await db.transaction(async (tx) => {
    await tx.update(staff).set({ role, updatedAt: new Date() }).where(eq(staff.id, staffId));
    await recordAudit(tx, {
      actor: { type: "staff", staffId: viewer.staffId },
      action: "staff.role.changed",
      target: { type: "staff", id: staffId },
      metadata: { from: target.role, to: role, characterName: target.characterName },
      request,
    });
  });
}

/**
 * A character's name changed in the game (2026-11-02). Staff are recognised by State ID everywhere, so only the name
 * shown changes — on every page, past records included. The sign-in account's name follows; the username doesn't.
 */
export async function changeName(viewer: Viewer, staffId: string, characterName: string): Promise<void> {
  const target = await loadManageable(viewer, staffId);
  if (target.characterName === characterName) return;
  const request = await getRequestMeta();
  await db.transaction(async (tx) => {
    await tx.update(staff).set({ characterName, updatedAt: new Date() }).where(eq(staff.id, staffId));
    if (target.userId) await tx.update(user).set({ name: characterName, updatedAt: new Date() }).where(eq(user.id, target.userId));
    await recordAudit(tx, {
      actor: { type: "staff", staffId: viewer.staffId },
      action: "staff.name.changed",
      target: { type: "staff", id: staffId },
      metadata: { from: target.characterName, to: characterName, stateId: target.stateId },
      request,
    });
  });
}

const TRANSITIONS = {
  suspend: { from: ["active"], to: "suspended", action: "staff.suspended" },
  reactivate: { from: ["suspended"], to: "active", action: "staff.reactivated" },
  depart: { from: ["active", "suspended", "invited"], to: "departed", action: "staff.departed" },
} as const;

export type StatusChange = keyof typeof TRANSITIONS;

/** Suspending or marking departed revokes every session immediately. */
export async function changeStatus(viewer: Viewer, staffId: string, change: StatusChange, reason: string): Promise<void> {
  const target = await loadManageable(viewer, staffId);
  const t = TRANSITIONS[change];
  if (!(t.from as readonly string[]).includes(target.status)) {
    throw new ForbiddenError(`Can't ${change} someone who is ${target.status}.`);
  }
  const request = await getRequestMeta();
  await db.transaction(async (tx) => {
    await tx.update(staff).set({ status: t.to, updatedAt: new Date() }).where(eq(staff.id, staffId));
    let revoked = 0;
    if (t.to !== "active" && target.userId) {
      const deleted = await tx.delete(session).where(eq(session.userId, target.userId)).returning({ id: session.id });
      revoked = deleted.length;
    }
    if (change === "depart") {
      await tx
        .update(staffInvite)
        .set({ revokedAt: new Date() })
        .where(and(eq(staffInvite.staffId, staffId), isNull(staffInvite.acceptedAt), isNull(staffInvite.revokedAt)));
    }
    await recordAudit(tx, {
      actor: { type: "staff", staffId: viewer.staffId },
      action: t.action,
      target: { type: "staff", id: staffId },
      reason,
      metadata: { from: target.status, to: t.to, sessionsRevoked: revoked, characterName: target.characterName },
      request,
    });
  });
}

/**
 * Clears another person's two-factor setup (lost phone, new device). Executives
 * only; sensitive (fresh 2FA + reason). They're signed out everywhere and must
 * set up an authenticator again at their next sign-in.
 */
export async function resetTwoFactor(viewer: Viewer, staffId: string, reason: string): Promise<void> {
  if (!can(viewer.role, "staff.reset_2fa")) throw new ForbiddenError();
  requireFreshStepUp(viewer);
  const target = await loadManageable(viewer, staffId);
  if (!target.userId) throw new ForbiddenError("This person hasn't set up their account yet.");
  const request = await getRequestMeta();
  await db.transaction(async (tx) => {
    const removed = await tx.delete(twoFactor).where(eq(twoFactor.userId, target.userId!)).returning({ id: twoFactor.id });
    const keys = await tx.delete(passkey).where(eq(passkey.userId, target.userId!)).returning({ id: passkey.id });
    await tx.update(user).set({ twoFactorEnabled: false, updatedAt: new Date() }).where(eq(user.id, target.userId!));
    const sessions = await tx.delete(session).where(eq(session.userId, target.userId!)).returning({ id: session.id });
    await recordAudit(tx, {
      actor: { type: "staff", staffId: viewer.staffId },
      action: "staff.two_factor.reset",
      target: { type: "staff", id: staffId },
      reason,
      metadata: { characterName: target.characterName, authenticatorsRemoved: removed.length, passkeysRemoved: keys.length, sessionsRevoked: sessions.length },
      request,
    });
  });
}

export async function staffCounts() {
  const rows = await db
    .select({ status: staff.status, count: sql<number>`count(*)::int` })
    .from(staff)
    .groupBy(staff.status);
  return Object.fromEntries(rows.map((r) => [r.status, r.count])) as Partial<Record<StaffRow["status"], number>>;
}

/** Staff matching a name fragment or State ID, for the search palette (caller checks `staff.view`). */
export async function searchStaff(q: string): Promise<{ id: string; name: string; stateId: number; role: string }[]> {
  const term = cleanSearch(q);
  const id = asStateId(term);
  if (!term || (/^\d+$/.test(term) && id === null)) return [];
  const where = id !== null ? eq(staff.stateId, id) : ilike(staff.characterName, `%${likeEscape(term)}%`);
  return db.select({ id: staff.id, name: staff.characterName, stateId: staff.stateId, role: staff.role }).from(staff).where(where).limit(8);
}
