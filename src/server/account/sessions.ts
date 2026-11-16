import "server-only";
import { and, desc, eq, gt, ne } from "drizzle-orm";
import { formatIp } from "@/lib/ip";
import { ForbiddenError } from "@/lib/permissions";
import { recordAudit } from "@/server/audit/audit";
import type { Viewer } from "@/server/authz/viewer";
import { db } from "@/server/db";
import { session } from "@/server/db/schema";
import { getRequestMeta } from "@/server/request";

/** Session DTO — deliberately excludes the token. */
export type SessionInfo = {
  id: string;
  current: boolean;
  createdAt: Date;
  lastActiveAt: Date;
  ip: string | null;
  device: string;
};

/** Coarse "Browser on OS" description; we never need the full UA in the UI. */
export function describeUserAgent(ua: string | null): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "Browser";
  const os = /Windows/.test(ua)
    ? "Windows"
    : /iPhone|iPad/.test(ua)
      ? "iOS"
      : /Mac OS X/.test(ua)
        ? "macOS"
        : /Android/.test(ua)
          ? "Android"
          : /Linux/.test(ua)
            ? "Linux"
            : "unknown OS";
  return `${browser} on ${os}`;
}

export async function listMySessions(viewer: Viewer): Promise<SessionInfo[]> {
  const rows = await db
    .select()
    .from(session)
    .where(and(eq(session.userId, viewer.userId), gt(session.expiresAt, new Date())))
    .orderBy(desc(session.updatedAt));
  return rows.map((s) => ({
    id: s.id,
    current: s.id === viewer.sessionId,
    createdAt: s.createdAt,
    lastActiveAt: s.updatedAt,
    ip: formatIp(s.ipAddress),
    device: describeUserAgent(s.userAgent),
  }));
}

/** Ends one of the viewer's own sessions (never another user's). */
export async function revokeMySession(viewer: Viewer, sessionId: string): Promise<void> {
  if (sessionId === viewer.sessionId) throw new ForbiddenError("Use Sign out to end your current session.");
  const request = await getRequestMeta();
  await db.transaction(async (tx) => {
    const deleted = await tx
      .delete(session)
      .where(and(eq(session.id, sessionId), eq(session.userId, viewer.userId)))
      .returning({ id: session.id });
    if (deleted.length === 0) throw new ForbiddenError("That session has already ended.");
    await recordAudit(tx, {
      actor: { type: "staff", staffId: viewer.staffId },
      action: "auth.session.revoked",
      target: { type: "staff", id: viewer.staffId },
      request,
    });
  });
}

export async function revokeMyOtherSessions(viewer: Viewer): Promise<number> {
  const request = await getRequestMeta();
  return db.transaction(async (tx) => {
    const deleted = await tx
      .delete(session)
      .where(and(eq(session.userId, viewer.userId), ne(session.id, viewer.sessionId)))
      .returning({ id: session.id });
    await recordAudit(tx, {
      actor: { type: "staff", staffId: viewer.staffId },
      action: "auth.session.revoked_others",
      target: { type: "staff", id: viewer.staffId },
      metadata: { sessionsRevoked: deleted.length },
      request,
    });
    return deleted.length;
  });
}
