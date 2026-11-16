import "server-only";
import { asc, desc, gt, sql } from "drizzle-orm";
import { db, type Db, type Tx } from "@/server/db";
import { auditEvent } from "@/server/db/schema";
import { env } from "@/server/env";
import { computeAuditHash, GENESIS_HASH, hashesEqual, type ChainedFields } from "./chain";

export type AuditInput = {
  actor: { type: "staff"; staffId: string } | { type: "system" } | { type: "anonymous" };
  action: string;
  target?: { type: string; id: string };
  reason?: string;
  metadata?: Record<string, unknown>;
  request?: { ip: string | null; userAgent: string | null };
};

/** Arbitrary constant identifying the chain's advisory lock. */
const CHAIN_LOCK_KEY = 0x4c4c4155; // "LLAU"

/**
 * Appends an audit event. Pass the caller's transaction so the event commits
 * or rolls back together with the change it describes. Appends are serialised
 * with a transaction-scoped advisory lock so the chain stays linear.
 */
export async function recordAudit(executor: Db | Tx, input: AuditInput): Promise<void> {
  const write = async (tx: Tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${CHAIN_LOCK_KEY})`);
    const [last] = await tx
      .select({ hash: auditEvent.hash })
      .from(auditEvent)
      .orderBy(desc(auditEvent.id))
      .limit(1);

    const fields: ChainedFields = {
      occurredAt: new Date(),
      actorType: input.actor.type,
      actorStaffId: input.actor.type === "staff" ? input.actor.staffId : null,
      action: input.action,
      targetType: input.target?.type ?? null,
      targetId: input.target?.id ?? null,
      reason: input.reason ?? null,
      metadata: input.metadata ?? {},
      ip: input.request?.ip ?? null,
      userAgent: input.request?.userAgent ?? null,
      prevHash: last?.hash ?? GENESIS_HASH,
    };
    await tx.insert(auditEvent).values({ ...fields, hash: computeAuditHash(env.AUDIT_HMAC_KEY, fields) });
  };

  // A Tx has no `$client`; the root db does. Open a transaction only if needed.
  if ("$client" in executor) await executor.transaction(write);
  else await write(executor);
}

export type ChainVerification =
  | { ok: true; checked: number }
  | { ok: false; checked: number; brokenAtId: bigint; problem: "hash_mismatch" | "link_mismatch" };

/** Re-computes the whole chain. Streams in pages to keep memory flat. */
export async function verifyAuditChain(pageSize = 1000): Promise<ChainVerification> {
  let prev = GENESIS_HASH;
  let lastId = BigInt(0);
  let checked = 0;
  for (;;) {
    const rows = await db
      .select()
      .from(auditEvent)
      .where(gt(auditEvent.id, lastId))
      .orderBy(asc(auditEvent.id))
      .limit(pageSize);
    if (rows.length === 0) return { ok: true, checked };
    for (const row of rows) {
      if (row.prevHash !== prev) return { ok: false, checked, brokenAtId: row.id, problem: "link_mismatch" };
      const expected = computeAuditHash(env.AUDIT_HMAC_KEY, {
        occurredAt: row.occurredAt,
        actorType: row.actorType,
        actorStaffId: row.actorStaffId,
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        reason: row.reason,
        metadata: row.metadata,
        ip: row.ip,
        userAgent: row.userAgent,
        prevHash: row.prevHash,
      });
      if (!hashesEqual(expected, row.hash)) {
        return { ok: false, checked, brokenAtId: row.id, problem: "hash_mismatch" };
      }
      prev = row.hash;
      lastId = row.id;
      checked++;
    }
  }
}
