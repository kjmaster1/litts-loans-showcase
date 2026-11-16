import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import { can, ForbiddenError } from "@/lib/permissions";
import { recordAudit, type AuditInput } from "@/server/audit/audit";
import { hashPassword } from "better-auth/crypto";
import { requireFreshStepUp } from "@/server/auth/step-up-guard";
import type { Viewer } from "@/server/authz/viewer";
import { db } from "@/server/db";
import { account, session, staff, staffPasswordReset, user } from "@/server/db/schema";
import { env } from "@/server/env";
import { getRequestMeta } from "@/server/request";
import { InviteError } from "./invites";
import { loadManageable } from "./service";

/**
 * Password reset for someone who has lost their password (owner, 2026-10-10).
 * There's no email, so an executive issues a one-time link (fresh 2FA + reason),
 * sends it privately, and the person chooses a new password. Their authenticator
 * is untouched, so the link alone can't get anyone in. Every step is audited and
 * they're signed out everywhere.
 */

export const RESET_TTL_SECONDS = 24 * 60 * 60;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export function resetUrl(token: string): string {
  return new URL(`/reset-password/${token}`, env.BETTER_AUTH_URL).toString();
}

export const issueResetSchema = z.object({
  staffId: z.uuid(),
  reason: z.string().trim().min(5, "Give a short reason (at least 5 characters).").max(500),
});

export async function issuePasswordReset(viewer: Viewer, raw: z.input<typeof issueResetSchema>): Promise<{ url: string; expiresAt: Date }> {
  if (!can(viewer.role, "staff.reset_password")) throw new ForbiddenError();
  requireFreshStepUp(viewer);
  const { staffId, reason } = issueResetSchema.parse(raw);
  const target = await loadManageable(viewer, staffId);
  return createPasswordReset({ target, reason, actor: { type: "staff", staffId: viewer.staffId }, request: await getRequestMeta() });
}

/**
 * Issues the link. Authorization is the caller's job: the Staff page action above, or
 * the break-glass CLI (`pnpm staff:reset-password:prod`, audited as `system`) for when no
 * executive above the person can sign in.
 */
export async function createPasswordReset(input: {
  target: { id: string; userId: string | null; status: string; characterName: string };
  reason: string;
  actor: AuditInput["actor"];
  request?: AuditInput["request"];
}): Promise<{ url: string; expiresAt: Date }> {
  const { target, reason } = input;
  const staffId = target.id;
  if (!target.userId || target.status !== "active") throw new ForbiddenError("Only someone with an active account can have their password reset.");
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + RESET_TTL_SECONDS * 1000);
  const createdByStaffId = input.actor.type === "staff" ? input.actor.staffId : null;
  await db.transaction(async (tx) => {
    // Any earlier link stops working.
    await tx
      .update(staffPasswordReset)
      .set({ revokedAt: new Date() })
      .where(and(eq(staffPasswordReset.staffId, staffId), isNull(staffPasswordReset.usedAt), isNull(staffPasswordReset.revokedAt)));
    await tx.insert(staffPasswordReset).values({ staffId, tokenHash: hashToken(token), expiresAt, createdByStaffId });
    const sessions = await tx.delete(session).where(eq(session.userId, target.userId!)).returning({ id: session.id });
    await recordAudit(tx, {
      actor: input.actor,
      action: "staff.password_reset.issued",
      target: { type: "staff", id: staffId },
      reason,
      metadata: { characterName: target.characterName, expiresAt, sessionsRevoked: sessions.length },
      request: input.request,
    });
  });
  return { url: resetUrl(token), expiresAt };
}

export type PendingReset = { resetId: string; staffId: string; userId: string; characterName: string; stateId: number; username: string | null };

/** A usable link: not used, revoked or expired, for an active account. */
export async function findPasswordReset(token: string): Promise<PendingReset | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const [row] = await db
    .select({
      resetId: staffPasswordReset.id,
      staffId: staff.id,
      userId: staff.userId,
      characterName: staff.characterName,
      stateId: staff.stateId,
      username: user.username,
    })
    .from(staffPasswordReset)
    .innerJoin(staff, eq(staff.id, staffPasswordReset.staffId))
    .innerJoin(user, eq(user.id, staff.userId))
    .where(
      and(
        eq(staffPasswordReset.tokenHash, hashToken(token)),
        isNull(staffPasswordReset.usedAt),
        isNull(staffPasswordReset.revokedAt),
        gt(staffPasswordReset.expiresAt, new Date()),
        eq(staff.status, "active"),
      ),
    )
    .limit(1);
  return row && row.userId ? { ...row, userId: row.userId } : null;
}

/** Have I Been Pwned (k-anonymity: only 5 characters of the SHA-1 leave the server), as at sign-up. */
async function isBreached(password: string): Promise<boolean> {
  if (env.NODE_ENV === "test") return false;
  const sha1 = createHash("sha1").update(password).digest("hex").toUpperCase();
  // A slow answer mustn't hold the request open (review 2026-10-13): give up after 5 seconds and ask them to try again.
  const res = await fetch(`https://api.pwnedpasswords.com/range/${sha1.slice(0, 5)}`, { headers: { "Add-Padding": "true" }, signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`Password check failed (${res.status})`);
  const suffix = sha1.slice(5);
  return (await res.text()).split(/\r?\n/).some((line) => line.startsWith(`${suffix}:`) && Number(line.slice(suffix.length + 1)) > 0);
}

export const newPasswordSchema = z
  .object({
    password: z.string().min(12, "Use at least 12 characters.").max(128, "Use at most 128 characters."),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { path: ["confirm"], message: "Passwords don't match." });

/** Sets the new password, uses up the link and signs them out everywhere. */
export async function completePasswordReset(token: string, password: string, request?: AuditInput["request"]): Promise<void> {
  const reset = await findPasswordReset(token);
  if (!reset) throw new InviteError("This link is invalid, expired or already used.", "invalid");
  if (await isBreached(password)) throw new InviteError("This password has appeared in a data breach. Choose another.", "weak_password");
  // Better Auth's own hasher (the app doesn't configure a custom one). Not `auth.$context.password.hash`:
  // the breach-check plugin wraps that and only works inside an auth endpoint.
  const hash = await hashPassword(password);
  await db.transaction(async (tx) => {
    const used = await tx
      .update(staffPasswordReset)
      .set({ usedAt: new Date() })
      .where(and(eq(staffPasswordReset.id, reset.resetId), isNull(staffPasswordReset.usedAt), isNull(staffPasswordReset.revokedAt)))
      .returning({ id: staffPasswordReset.id });
    if (used.length !== 1) throw new InviteError("This link has already been used.", "invalid");
    const updated = await tx
      .update(account)
      .set({ password: hash, updatedAt: new Date() })
      .where(and(eq(account.userId, reset.userId), eq(account.providerId, "credential")))
      .returning({ id: account.id });
    if (updated.length !== 1) throw new Error(`no password login for user ${reset.userId}`);
    const sessions = await tx.delete(session).where(eq(session.userId, reset.userId)).returning({ id: session.id });
    await recordAudit(tx, {
      actor: { type: "staff", staffId: reset.staffId },
      action: "staff.password_reset.completed",
      target: { type: "staff", id: reset.staffId },
      metadata: { characterName: reset.characterName, sessionsRevoked: sessions.length },
      request,
    });
  });
}
