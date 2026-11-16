import "server-only";
import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from "better-auth/api";
import { eq } from "drizzle-orm";
import { recordAudit, type AuditInput } from "@/server/audit/audit";
import { db } from "@/server/db";
import { staff, user } from "@/server/db/schema";
import { STEP_UP_WINDOW_SECONDS } from "@/lib/session-policy";
import { STEP_UP_REQUIRED } from "@/lib/step-up";
import { userVerified } from "@/lib/webauthn";

/**
 * Writes authentication events to the audit trail (SPEC §8). The `after` hook
 * sees either the endpoint's result or the APIError it threw, so failures are
 * recorded as well as successes. Never logs secrets — only the attempted
 * username and outcome.
 *
 * Classification relies on facts verified against better-auth 1.7 behaviour
 * (see tests/integration/auth-audit.test.ts):
 * - user hooks run before plugin hooks, so the two-factor plugin hasn't yet
 *   rewritten a password sign-in into `{ twoFactorRedirect: true }`; instead,
 *   with trusted devices disabled, a correct password for a user with 2FA
 *   enabled is always "pending 2FA";
 * - completing 2FA at sign-in carries the pending `two_factor` cookie, whereas
 *   confirming enrolment happens inside an existing session;
 * - on sign-out the session is gone by the `after` phase, so it's logged `before`.
 */

const AFTER_EVENTS: Record<string, { ok: string; fail: string }> = {
  "/sign-in/username": { ok: "auth.sign_in.succeeded", fail: "auth.sign_in.failed" },
  "/two-factor/verify-totp": { ok: "auth.2fa.verified", fail: "auth.2fa.failed" },
  "/two-factor/verify-backup-code": { ok: "auth.sign_in.succeeded", fail: "auth.2fa.backup_code_failed" },
  "/two-factor/enable": { ok: "auth.2fa.enrollment_started", fail: "auth.2fa.enrollment_failed" },
  "/two-factor/generate-backup-codes": { ok: "auth.2fa.backup_codes_regenerated", fail: "auth.2fa.backup_codes_failed" },
  "/change-password": { ok: "auth.password.changed", fail: "auth.password.change_failed" },
  "/passkey/verify-authentication": { ok: "auth.sign_in.succeeded", fail: "auth.sign_in.failed" },
  "/passkey/verify-registration": { ok: "auth.passkey.added", fail: "auth.passkey.add_failed" },
  "/passkey/delete-passkey": { ok: "auth.passkey.removed", fail: "auth.passkey.remove_failed" },
};

type HookCtx = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

function requestMeta(ctx: HookCtx): AuditInput["request"] {
  const headers = ctx.request?.headers ?? ctx.headers;
  return {
    ip: headers?.get("x-forwarded-for")?.split(",")[0]?.trim() || headers?.get("x-real-ip") || null,
    userAgent: headers?.get("user-agent")?.slice(0, 512) ?? null,
  };
}

function hasPendingTwoFactorCookie(ctx: HookCtx): boolean {
  const cookie = (ctx.request?.headers ?? ctx.headers)?.get("cookie") ?? "";
  return /(^|;\s*)(__Secure-)?litts\.two_factor=/.test(cookie);
}

async function staffIdForUser(userId: string | undefined): Promise<string | null> {
  if (!userId) return null;
  const row = await db.query.staff.findFirst({ columns: { id: true }, where: eq(staff.userId, userId) });
  return row?.id ?? null;
}

async function lookupUsername(username: string) {
  const u = await db.query.user.findFirst({
    columns: { id: true, twoFactorEnabled: true },
    where: eq(user.username, username.toLowerCase()),
  });
  return { staffId: await staffIdForUser(u?.id), twoFactorEnabled: Boolean(u?.twoFactorEnabled) };
}

async function write(ctx: HookCtx, action: string, actorStaffId: string | null, metadata: Record<string, unknown>) {
  try {
    await recordAudit(db, {
      actor: actorStaffId ? { type: "staff", staffId: actorStaffId } : { type: "anonymous" },
      action,
      target: actorStaffId ? { type: "staff", id: actorStaffId } : undefined,
      metadata,
      request: requestMeta(ctx),
    });
  } catch (error) {
    // Auditing must never break authentication; surface loudly in logs instead.
    console.error("[audit] failed to record auth event", action, error);
  }
}

export const authAuditBeforeHook = createAuthMiddleware(async (ctx) => {
  // Adding a passkey creates a new way into the account: it needs a fresh step-up (ADR 0002).
  if (ctx.path === "/passkey/generate-register-options") {
    const current = await getSessionFromCtx(ctx).catch(() => null);
    const stepUpAt = (current?.session as { stepUpAt?: Date | string | null } | undefined)?.stepUpAt;
    const fresh = stepUpAt && Date.now() - new Date(stepUpAt).getTime() <= STEP_UP_WINDOW_SECONDS * 1000;
    if (!current || !current.user.twoFactorEnabled || !fresh) throw new APIError("FORBIDDEN", { message: STEP_UP_REQUIRED });
    return;
  }
  // A passkey replaces password + code only if the device verified the person.
  if (ctx.path === "/passkey/verify-authentication") {
    const body = ctx.body as { response?: { response?: { authenticatorData?: unknown } } } | undefined;
    if (userVerified(body?.response?.response?.authenticatorData) !== true) {
      await write(ctx, "auth.sign_in.failed", null, { method: "passkey", error: "USER_NOT_VERIFIED" });
      throw new APIError("UNAUTHORIZED", { message: "Your passkey must confirm it's you with a fingerprint, face or PIN." });
    }
    return;
  }
  if (ctx.path !== "/sign-out") return;
  const current = await getSessionFromCtx(ctx).catch(() => null);
  if (!current) return;
  await write(ctx, "auth.sign_out", await staffIdForUser(current.user.id), {});
});

export const authAuditAfterHook = createAuthMiddleware(async (ctx) => {
  const event = AFTER_EVENTS[ctx.path];
  if (!event) return;

  const returned = ctx.context.returned as unknown;
  const failed = isAPIError(returned);
  const metadata: Record<string, unknown> = {};
  let action = failed ? event.fail : event.ok;
  let actorStaffId: string | null;

  if (ctx.path === "/sign-in/username") {
    const attempted = typeof ctx.body?.username === "string" ? ctx.body.username.slice(0, 64) : null;
    metadata.username = attempted;
    const found = attempted ? await lookupUsername(attempted) : null;
    actorStaffId = found?.staffId ?? null;
    const pending = !failed && found?.twoFactorEnabled === true;
    if (pending) action = "auth.sign_in.password_ok";
    else if (!failed) metadata.method = "password_only"; // only possible before 2FA enrolment
  } else {
    const userId = ctx.context.newSession?.user.id ?? ctx.context.session?.user.id;
    actorStaffId = await staffIdForUser(userId);
    if (ctx.path === "/two-factor/verify-totp" && !failed) {
      const atSignIn = hasPendingTwoFactorCookie(ctx);
      action = atSignIn ? "auth.sign_in.succeeded" : "auth.2fa.enabled";
      if (atSignIn) metadata.method = "totp";
    }
    if (ctx.path === "/two-factor/verify-backup-code" && !failed) metadata.method = "backup_code";
    if (ctx.path === "/passkey/verify-authentication") metadata.method = "passkey";
  }

  if (failed) {
    const err = returned as { body?: { code?: string }; status?: string | number };
    metadata.error = err.body?.code ?? err.status;
  }
  await write(ctx, action, actorStaffId, metadata);
});
