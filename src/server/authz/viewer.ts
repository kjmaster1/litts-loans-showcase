import "server-only";
import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import type { Role } from "@/lib/roles";
import { auth } from "@/server/auth/auth";
import { SESSION_ABSOLUTE_SECONDS } from "@/lib/session-policy";
import { db } from "@/server/db";
import { session as sessionTable, staff } from "@/server/db/schema";
import { can, ForbiddenError, type Capability } from "@/lib/permissions";

/** The authenticated staff member for this request. Safe to pass to the client. */
export type Viewer = {
  staffId: string;
  userId: string;
  sessionId: string;
  role: Role;
  characterName: string;
  stateId: number;
  username: string;
  twoFactorEnabled: boolean;
  /** ISO time of last step-up, if any. */
  stepUpAt: string | null;
  /** The app tour: when it was finished or skipped (ISO), and the role it was taken as. */
  tourCompletedAt: string | null;
  tourRole: Role | null;
};

type ViewerResult =
  | { status: "ok"; viewer: Viewer }
  | { status: "anonymous" }
  | { status: "expired" }
  | { status: "inactive" };

/**
 * Resolves the session once per request (React `cache`). Deliberately NOT
 * `use cache: private`: a finance app must honour revocation and the idle
 * timeout on every request rather than serve a cached session (ADR 0003).
 */
const resolveViewer = cache(async (): Promise<ViewerResult> => {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return { status: "anonymous" };

  const ageSeconds = (Date.now() - new Date(session.session.createdAt).getTime()) / 1000;
  if (ageSeconds > SESSION_ABSOLUTE_SECONDS) {
    await db.delete(sessionTable).where(eq(sessionTable.id, session.session.id));
    return { status: "expired" };
  }

  const member = await db.query.staff.findFirst({
    where: and(eq(staff.userId, session.user.id), eq(staff.status, "active")),
  });
  if (!member) {
    await db.delete(sessionTable).where(eq(sessionTable.userId, session.user.id));
    return { status: "inactive" };
  }

  const stepUpAt = (session.session as { stepUpAt?: Date | string | null }).stepUpAt;
  return {
    status: "ok",
    viewer: {
      staffId: member.id,
      userId: session.user.id,
      sessionId: session.session.id,
      role: member.role,
      characterName: member.characterName,
      stateId: member.stateId,
      username: (session.user as { username?: string | null }).username ?? "",
      twoFactorEnabled: Boolean(session.user.twoFactorEnabled),
      stepUpAt: stepUpAt ? new Date(stepUpAt).toISOString() : null,
      tourCompletedAt: member.tourCompletedAt ? member.tourCompletedAt.toISOString() : null,
      tourRole: member.tourRole,
    },
  };
});

/** For pages: redirects instead of throwing. */
export async function requireViewer(options: { allowUnenrolled?: boolean } = {}): Promise<Viewer> {
  const result = await resolveViewer();
  if (result.status === "anonymous") redirect("/sign-in");
  if (result.status === "expired") redirect("/sign-in?reason=expired");
  if (result.status === "inactive") redirect("/sign-in?reason=inactive");
  if (!result.viewer.twoFactorEnabled && !options.allowUnenrolled) redirect("/enroll-2fa");
  return result.viewer;
}

/**
 * For pages gated on a capability. Uses a redirect to `/forbidden` rather than
 * Next's `forbidden()`, which is still experimental (authInterrupts) in 16.4.
 */
export async function requireCapabilityPage(capability: Capability): Promise<Viewer> {
  const viewer = await requireViewer();
  if (!can(viewer.role, capability)) redirect("/forbidden");
  return viewer;
}

/**
 * For Server Actions / Route Handlers: throws instead of redirecting, since an
 * action is its own entry point and must authorise itself (Next.js data-security
 * guidance). Requires 2FA enrolment unconditionally.
 */
export async function authorize(capability?: Capability): Promise<Viewer> {
  const result = await resolveViewer();
  if (result.status !== "ok" || !result.viewer.twoFactorEnabled) throw new ForbiddenError("Please sign in again.");
  if (capability && !can(result.viewer.role, capability)) throw new ForbiddenError();
  return result.viewer;
}

export { hasFreshStepUp } from "@/server/auth/step-up-guard";
