import { bigserial, index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const auditActorType = pgEnum("audit_actor_type", ["staff", "system", "anonymous"]);

/**
 * Append-only, HMAC-chained audit trail. UPDATE/DELETE/TRUNCATE are rejected by
 * a trigger (see migration `audit_event_immutable`). Each row's `hash` covers its
 * own canonical content plus the previous row's hash, so removing, reordering
 * or editing any row breaks verification from that point on.
 */
export const auditEvent = pgTable(
  "audit_event",
  {
    id: bigserial({ mode: "bigint" }).primaryKey(),
    occurredAt: timestamp({ withTimezone: true, precision: 6 }).notNull(),
    actorType: auditActorType().notNull(),
    actorStaffId: uuid(),
    /** Dotted verb, e.g. `staff.invite.created`, `auth.sign_in.failed`. */
    action: text().notNull(),
    targetType: text(),
    targetId: text(),
    /** Mandatory for sensitive actions (ADR 0002). */
    reason: text(),
    /** Before/after values and other structured context. Never secrets. */
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    /** Stored as text (not inet): inet normalises values, which would break hash verification. */
    ip: text(),
    userAgent: text(),
    prevHash: text().notNull(),
    hash: text().notNull(),
  },
  (t) => [
    index("audit_event_occurred_at_idx").on(t.occurredAt),
    index("audit_event_actor_idx").on(t.actorStaffId),
    index("audit_event_target_idx").on(t.targetType, t.targetId),
    index("audit_event_action_idx").on(t.action),
  ],
);
