import "server-only";
import { aliasedTable, and, desc, eq, inArray, isNull, like, lt, not, or, sql, type SQL } from "drizzle-orm";
import { auditTarget } from "@/lib/audit-labels";
import { formatIp } from "@/lib/ip";
import { isExecutive } from "@/lib/roles";
import type { Viewer } from "@/server/authz/viewer";
import { db } from "@/server/db";
import { auditEvent, staff } from "@/server/db/schema";

export const AUDIT_CATEGORIES = {
  auth: "Sign-in & security",
  staff: "Staff & access",
  loans: "Loans",
  mortgages: "Mortgages",
  money: "Money & reports",
  settings: "Settings",
} as const;
/** Action prefixes in each category. */
const CATEGORY_PREFIXES: Record<keyof typeof AUDIT_CATEGORIES, string[]> = {
  auth: ["auth."],
  staff: ["staff."],
  loans: ["loans.", "borrowers."],
  mortgages: ["mortgages."],
  money: ["bank.", "ledger.", "allowance.", "commissions.", "report.", "list.", "data."],
  settings: ["settings."],
};
export type AuditCategory = keyof typeof AUDIT_CATEGORIES;

/**
 * Everyday sign-in steps: kept in the audit log, left out of the dashboard's "Recent activity"
 * (UX review 2026-10-12 -- they filled it). Failures and security changes still show.
 */
const ROUTINE_ACTIONS = ["auth.sign_in.succeeded", "auth.sign_in.password_ok", "auth.2fa.verified", "auth.sign_out", "auth.step_up.succeeded"];

export type AuditRow = {
  id: string;
  occurredAt: Date;
  action: string;
  actorName: string | null;
  actorType: "staff" | "system" | "anonymous";
  targetLabel: string | null;
  targetHref: string | null;
  reason: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
};

const actor = aliasedTable(staff, "actor");
const targetStaff = aliasedTable(staff, "target_staff");

/**
 * Paged audit feed, newest first (keyset pagination on id). Caller must hold
 * `audit.view`. Management sees everything except actions performed by
 * executives; Owner/CEO/COO see everything (SPEC §2 "own team").
 */
export async function listAuditEvents(
  viewer: Viewer,
  opts: { before?: bigint; category?: AuditCategory; pageSize?: number; hideRoutine?: boolean } = {},
): Promise<{ rows: AuditRow[]; nextBefore: string | null }> {
  const pageSize = opts.pageSize ?? 50;
  const filters: SQL[] = [];
  if (opts.before) filters.push(lt(auditEvent.id, opts.before));
  if (opts.hideRoutine) filters.push(not(inArray(auditEvent.action, ROUTINE_ACTIONS)));
  if (opts.category) filters.push(or(...CATEGORY_PREFIXES[opts.category].map((p) => like(auditEvent.action, `${p}%`)))!);
  if (!isExecutive(viewer.role)) {
    filters.push(or(isNull(actor.role), not(inArray(actor.role, ["owner", "ceo", "coo"])))!);
  }

  const rows = await db
    .select({
      id: auditEvent.id,
      occurredAt: auditEvent.occurredAt,
      action: auditEvent.action,
      actorType: auditEvent.actorType,
      actorName: actor.characterName,
      targetType: auditEvent.targetType,
      targetId: auditEvent.targetId,
      targetStaffName: targetStaff.characterName,
      reason: auditEvent.reason,
      metadata: auditEvent.metadata,
      ip: auditEvent.ip,
    })
    .from(auditEvent)
    .leftJoin(actor, eq(actor.id, auditEvent.actorStaffId))
    .leftJoin(
      targetStaff,
      and(eq(auditEvent.targetType, "staff"), sql`${targetStaff.id}::text = ${auditEvent.targetId}`),
    )
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(auditEvent.id))
    .limit(pageSize + 1);

  const page = rows.slice(0, pageSize);
  return {
    rows: page.map((r) => {
      const target = r.targetStaffName ? null : auditTarget(r.targetType, r.targetId, r.metadata);
      return {
      id: r.id.toString(),
      occurredAt: r.occurredAt,
      action: r.action,
      actorType: r.actorType,
      actorName: r.actorName,
      targetLabel: r.targetStaffName ?? target?.label ?? null,
      targetHref: target?.href ?? null,
      reason: r.reason,
      metadata: r.metadata,
      ip: formatIp(r.ip),
      };
    }),
    nextBefore: rows.length > pageSize ? page[page.length - 1].id.toString() : null,
  };
}
