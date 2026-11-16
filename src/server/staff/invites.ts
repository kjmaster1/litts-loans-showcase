import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { recordAudit, type AuditInput } from "@/server/audit/audit";
import { INVITE_TTL_SECONDS } from "@/lib/session-policy";
import { db } from "@/server/db";
import { staff, staffInvite, user } from "@/server/db/schema";
import type { Role } from "@/lib/roles";

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** 32 random bytes, URL-safe. Only its hash is stored. */
function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export class InviteError extends Error {
  constructor(
    message: string,
    readonly code: "state_id_taken" | "invalid" | "username_taken" | "weak_password",
  ) {
    super(message);
    this.name = "InviteError";
  }
}

/**
 * Creates (or re-issues) an invite for a staff member. Authorization is the
 * caller's job (Server Action / CLI); this records the audit event atomically.
 * Returns the raw token exactly once.
 */
export async function createInvite(input: {
  stateId: number;
  characterName: string;
  role: Role;
  actor: AuditInput["actor"];
  request?: AuditInput["request"];
}): Promise<{ token: string; staffId: string; expiresAt: Date }> {
  const token = newToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_SECONDS * 1000);
  const createdByStaffId = input.actor.type === "staff" ? input.actor.staffId : null;

  return db.transaction(async (tx) => {
    const existing = await tx.query.staff.findFirst({ where: eq(staff.stateId, input.stateId) });
    if (existing && existing.status !== "invited") {
      throw new InviteError(`State ID ${input.stateId} already belongs to ${existing.characterName}.`, "state_id_taken");
    }

    let staffId: string;
    if (existing) {
      // Re-invite: refresh details, revoke any outstanding links.
      staffId = existing.id;
      await tx
        .update(staff)
        .set({ characterName: input.characterName, role: input.role, updatedAt: new Date() })
        .where(eq(staff.id, staffId));
      await tx
        .update(staffInvite)
        .set({ revokedAt: new Date() })
        .where(and(eq(staffInvite.staffId, staffId), isNull(staffInvite.acceptedAt), isNull(staffInvite.revokedAt)));
    } else {
      const [row] = await tx
        .insert(staff)
        .values({
          stateId: input.stateId,
          characterName: input.characterName,
          role: input.role,
          status: "invited",
          createdByStaffId,
        })
        .returning({ id: staff.id });
      staffId = row.id;
    }

    await tx.insert(staffInvite).values({ staffId, tokenHash: hashInviteToken(token), expiresAt, createdByStaffId });
    await recordAudit(tx, {
      actor: input.actor,
      action: existing ? "staff.invite.reissued" : "staff.invite.created",
      target: { type: "staff", id: staffId },
      metadata: { stateId: input.stateId, characterName: input.characterName, role: input.role, expiresAt },
      request: input.request,
    });
    return { token, staffId, expiresAt };
  });
}

export type PendingInvite = {
  inviteId: string;
  staffId: string;
  characterName: string;
  stateId: number;
  role: Role;
  expiresAt: Date;
};

/** Looks up a usable invite (not expired, accepted or revoked). */
export async function findPendingInvite(token: string): Promise<PendingInvite | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const rows = await db
    .select({
      inviteId: staffInvite.id,
      staffId: staff.id,
      characterName: staff.characterName,
      stateId: staff.stateId,
      role: staff.role,
      expiresAt: staffInvite.expiresAt,
    })
    .from(staffInvite)
    .innerJoin(staff, eq(staff.id, staffInvite.staffId))
    .where(
      and(
        eq(staffInvite.tokenHash, hashInviteToken(token)),
        isNull(staffInvite.acceptedAt),
        isNull(staffInvite.revokedAt),
        gt(staffInvite.expiresAt, new Date()),
        eq(staff.status, "invited"),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Synthetic, non-routable address: Better Auth requires an email; we never send mail. */
export function placeholderEmail(staffId: string): string {
  return `${staffId}@staff.litts-loans.invalid`;
}

export async function isUsernameTaken(username: string): Promise<boolean> {
  const row = await db.query.user.findFirst({ columns: { id: true }, where: eq(user.username, username.toLowerCase()) });
  return Boolean(row);
}

/** Links the newly created login to the staff record and activates it, single-use. */
export async function completeInvite(input: {
  invite: PendingInvite;
  userId: string;
  request?: AuditInput["request"];
}): Promise<void> {
  await db.transaction(async (tx) => {
    const consumed = await tx
      .update(staffInvite)
      .set({ acceptedAt: new Date() })
      .where(and(eq(staffInvite.id, input.invite.inviteId), isNull(staffInvite.acceptedAt), isNull(staffInvite.revokedAt)))
      .returning({ id: staffInvite.id });
    if (consumed.length !== 1) throw new InviteError("This invite has already been used.", "invalid");

    await tx
      .update(staff)
      .set({ userId: input.userId, status: "active", updatedAt: new Date() })
      .where(and(eq(staff.id, input.invite.staffId), eq(staff.status, "invited")));

    await recordAudit(tx, {
      actor: { type: "staff", staffId: input.invite.staffId },
      action: "staff.invite.accepted",
      target: { type: "staff", id: input.invite.staffId },
      metadata: { stateId: input.invite.stateId, role: input.invite.role },
      request: input.request,
    });
  });
}
