import { desc, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { recordAudit, verifyAuditChain } from "@/server/audit/audit";
import { db } from "@/server/db";
import { auditEvent } from "@/server/db/schema";

async function latest() {
  const [row] = await db.select().from(auditEvent).orderBy(desc(auditEvent.id)).limit(1);
  return row;
}

describe("audit trail", () => {
  afterAll(async () => {
    const result = await verifyAuditChain();
    expect(result.ok, "chain must be intact after this suite").toBe(true);
  });

  it("links each event to the previous one", async () => {
    await recordAudit(db, { actor: { type: "system" }, action: "test.first", metadata: { n: 1 } });
    const first = await latest();
    await recordAudit(db, { actor: { type: "system" }, action: "test.second", metadata: { z: 1, a: [1, "x"] } });
    const second = await latest();
    expect(second.prevHash).toBe(first.hash);
    expect(await verifyAuditChain()).toMatchObject({ ok: true });
  });

  it("commits or rolls back together with the caller's transaction", async () => {
    const before = await latest();
    await expect(
      db.transaction(async (tx) => {
        await recordAudit(tx, { actor: { type: "system" }, action: "test.rolled_back" });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect((await latest()).id).toBe(before.id);
  });

  it("keeps a linear chain under concurrent writers", async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => recordAudit(db, { actor: { type: "system" }, action: `test.concurrent.${i}` })),
    );
    expect(await verifyAuditChain()).toMatchObject({ ok: true });
  });

  it("rejects UPDATE, DELETE and TRUNCATE at the database level", async () => {
    const row = await latest();
    // Drizzle wraps the driver error; the trigger's message is on `cause`.
    const blocked = { cause: expect.objectContaining({ message: expect.stringMatching(/append-only/) }) };
    await expect(db.update(auditEvent).set({ action: "forged" }).where(eq(auditEvent.id, row.id))).rejects.toMatchObject(blocked);
    await expect(db.delete(auditEvent).where(eq(auditEvent.id, row.id))).rejects.toMatchObject(blocked);
    await expect(db.execute(sql`truncate audit_event`)).rejects.toMatchObject(blocked);
    expect((await latest()).action).toBe(row.action);
  });

  it("detects tampering by someone who bypasses the trigger", async () => {
    const row = await latest();
    // Simulate a privileged attacker: disable the trigger, edit, re-enable.
    await db.execute(sql`alter table audit_event disable trigger audit_event_no_update_delete`);
    try {
      await db.update(auditEvent).set({ action: "forged" }).where(eq(auditEvent.id, row.id));
      const result = await verifyAuditChain();
      expect(result).toMatchObject({ ok: false, brokenAtId: row.id, problem: "hash_mismatch" });
    } finally {
      await db.update(auditEvent).set({ action: row.action }).where(eq(auditEvent.id, row.id));
      await db.execute(sql`alter table audit_event enable trigger audit_event_no_update_delete`);
    }
  });
});
