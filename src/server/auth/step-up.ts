import "server-only";
import { createOTP } from "@better-auth/utils/otp";
import { symmetricDecrypt } from "better-auth/crypto";
import { timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { ForbiddenError } from "@/lib/permissions";
import { STEP_UP_WINDOW_SECONDS } from "@/lib/session-policy";
import { STEP_UP_REQUIRED } from "@/lib/step-up";
import { recordAudit } from "@/server/audit/audit";
import { auth } from "@/server/auth/auth";
import type { Viewer } from "@/server/authz/viewer";
import { db } from "@/server/db";
import { session, staff, twoFactor } from "@/server/db/schema";
import { getRequestMeta } from "@/server/request";

/**
 * Step-up re-authentication for sensitive actions (ADR 0002): the user enters
 * a fresh authenticator code, which unlocks sensitive actions on *this session*
 * for STEP_UP_WINDOW_SECONDS.
 *
 * The code is checked exactly as Better Auth checks it at sign-in (same
 * encrypted secret, same decrypt key, same OTP library, the same ±1 step of
 * clock drift) and shares the two-factor lockout counter.
 *
 * Review 2026-10-13: the check runs with the two-factor row locked, so attempts
 * sent at the same moment queue up and each one counts towards the lockout
 * (they used to read the same count, so many could count as one). A code's time
 * step is remembered, so the same code can't be used for a second step-up.
 */

export { STEP_UP_REQUIRED };
export { hasFreshStepUp, requireFreshStepUp, StepUpRequiredError } from "./step-up-guard";

const MAX_FAILURES = 5;
const LOCK_MS = 5 * 60 * 1000;
const PERIOD_SECONDS = 30;
/** Steps either side of now that still count, as Better Auth allows at sign-in. */
const DRIFT_STEPS = 1;

/** The time step the code belongs to, or null if it matches none near now. Compares every candidate. */
async function matchingStep(secret: string, code: string, now: number): Promise<number | null> {
  const otp = createOTP(secret, { period: PERIOD_SECONDS, digits: 6 });
  const current = Math.floor(now / (PERIOD_SECONDS * 1000));
  let found: number | null = null;
  for (let step = current - DRIFT_STEPS; step <= current + DRIFT_STEPS; step++) {
    if (timingSafeEqual(Buffer.from(await otp.hotp(step)), Buffer.from(code)) && found === null) found = step;
  }
  return found;
}

type Outcome = { ok: true; until: Date } | { ok: false; message: string };

export async function verifyStepUp(viewer: Viewer, code: string): Promise<{ until: Date }> {
  if (!/^\d{6}$/.test(code)) throw new ForbiddenError("Enter the 6-digit code from your authenticator app.");
  const request = await getRequestMeta();
  const ctx = await auth.$context;

  // The transaction commits a failure as well as a success; the error is thrown afterwards.
  const outcome = await db.transaction(async (tx): Promise<Outcome> => {
    const [tf] = await tx.select().from(twoFactor).where(eq(twoFactor.userId, viewer.userId)).for("update");
    if (!tf) return { ok: false, message: "Two-factor authentication isn't set up on this account." };
    const now = new Date();
    if (tf.lockedUntil && tf.lockedUntil > now) return { ok: false, message: "Too many wrong codes. Try again in a few minutes." };
    const [member] = await tx.select({ stepUpCounter: staff.stepUpCounter }).from(staff).where(eq(staff.id, viewer.staffId)).for("update");

    const secret = await symmetricDecrypt({ key: ctx.secretConfig, data: tf.secret });
    const step = await matchingStep(secret, code, now.getTime());
    const replayed = step !== null && member?.stepUpCounter != null && step <= member.stepUpCounter;

    if (step === null || replayed) {
      const failures = (tf.failedVerificationCount ?? 0) + 1;
      await tx
        .update(twoFactor)
        .set({ failedVerificationCount: failures, lockedUntil: failures >= MAX_FAILURES ? new Date(now.getTime() + LOCK_MS) : tf.lockedUntil })
        .where(eq(twoFactor.id, tf.id));
      await recordAudit(tx, {
        actor: { type: "staff", staffId: viewer.staffId },
        action: "auth.step_up.failed",
        target: { type: "staff", id: viewer.staffId },
        metadata: replayed ? { reason: "code_already_used" } : {},
        request,
      });
      return { ok: false, message: replayed ? "That code was already used. Wait for the next one." : "That code didn't match." };
    }

    await tx.update(twoFactor).set({ failedVerificationCount: 0, lockedUntil: null }).where(eq(twoFactor.id, tf.id));
    await tx.update(staff).set({ stepUpCounter: step }).where(eq(staff.id, viewer.staffId));
    await tx.update(session).set({ stepUpAt: now }).where(eq(session.id, viewer.sessionId));
    await recordAudit(tx, {
      actor: { type: "staff", staffId: viewer.staffId },
      action: "auth.step_up.succeeded",
      target: { type: "staff", id: viewer.staffId },
      request,
    });
    return { ok: true, until: new Date(now.getTime() + STEP_UP_WINDOW_SECONDS * 1000) };
  });

  if (!outcome.ok) throw new ForbiddenError(outcome.message);
  return { until: outcome.until };
}
