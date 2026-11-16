import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/request", () => ({ getRequestMeta: async () => ({ ip: "203.0.113.10", userAgent: "vitest" }) }));

const { commitImport, stageImport } = await import("@/server/bank/import");
const { trialBalance } = await import("@/server/ledger/queries");
const { db } = await import("@/server/db");
const { staff } = await import("@/server/db/schema");
const { resetDb } = await import("../support/db");

/**
 * QA 2026-10-13: tax on a payment going out is the recipient's, so it stays out of the tax memo (9000).
 * Migration 0025 re-posts rows the old rule booked there, the way a reclassification does.
 */

const MIGRATION = readFileSync("drizzle/0025_outgoing_tax_memo.sql", "utf8");
const memo = async () => (await trialBalance()).find((a) => a.code === "9000")?.balanceCents ?? 0;
const runMigration = () => db.transaction((tx) => tx.execute(sql.raw(MIGRATION)));

let outRow: { id: string; posting: string; tax: number };

beforeAll(async () => {
  await resetDb();
  const [row] = await db.insert(staff).values({ stateId: 454545, characterName: "Tax Tester", role: "ceo", status: "active" }).returning();
  const viewer = { staffId: row.id, userId: "u", sessionId: "s", role: "ceo" as const, characterName: row.characterName, stateId: row.stateId, username: "tax.tester", twoFactorEnabled: true, stepUpAt: null, tourCompletedAt: null, tourRole: null };
  await commitImport(viewer, await stageImport(viewer, { name: "export.xlsx", bytes: readFileSync("tests/fixtures/bank-export.xlsx") }));
  const { rows } = await db.execute<{ id: string; posting: string; tax: string }>(sql`
    select id, posting_entry_id as posting, tax_cents as tax from bank_transaction where direction = 'out' and tax_cents > 0`);
  expect(rows).toHaveLength(1); // the flyer invoice
  outRow = { ...rows[0], tax: Number(rows[0].tax) };
});

describe("tax on a payment going out", () => {
  it("isn't booked into the company's tax memo on import", async () => {
    const { rows } = await db.execute(sql`select 1 from journal_line where entry_id = ${outRow.posting} and account_code in ('9000', '9090')`);
    expect(rows).toHaveLength(0);
    const { rows: [t] } = await db.execute<{ withheld: string; recorded: string }>(sql`
      select (select sum(tax_cents) from bank_transaction where direction = 'in') as withheld,
             (select coalesce(sum(amount_cents), 0) from bank_transaction where category = 'tax.remittance_record') as recorded`);
    expect(await memo()).toBe(Number(t.withheld) - Number(t.recorded));
  });

  it("is taken out of the memo by migration 0025 where the old rule put it, once", async () => {
    // The old rule's posting: the same lines plus the memo pair.
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local session_replication_role = replica`);
      await tx.execute(sql`insert into journal_line (entry_id, account_code, debit_cents, credit_cents, memo) values
        (${outRow.posting}, '9000', ${outRow.tax}, 0, 'Tax withheld (memo)'), (${outRow.posting}, '9090', 0, ${outRow.tax}, 'Tax withheld (memo)')`);
    });
    const before = await memo();
    const cashBefore = (await trialBalance()).find((a) => a.code === "1000")!.balanceCents;

    await runMigration();

    expect(await memo()).toBe(before - outRow.tax);
    expect((await trialBalance()).find((a) => a.code === "1000")!.balanceCents).toBe(cashBefore);
    const { rows: [b] } = await db.execute<{ posting: string }>(sql`select posting_entry_id as posting from bank_transaction where id = ${outRow.id}`);
    expect(b.posting).not.toBe(outRow.posting);
    const { rows: rev } = await db.execute(sql`select 1 from journal_entry where kind = 'reversal' and reverses_entry_id = ${outRow.posting}`);
    expect(rev).toHaveLength(1);
    const { rows: fresh } = await db.execute<{ account_code: string }>(sql`select account_code from journal_line where entry_id = ${b.posting} order by account_code`);
    expect(fresh.map((r) => r.account_code)).toEqual(["1000", "5500"]);

    // Again: nothing left to do.
    await runMigration();
    expect(await memo()).toBe(before - outRow.tax);
    const tb = await trialBalance();
    expect(tb.reduce((s, r) => s + r.debitCents, 0)).toBe(tb.reduce((s, r) => s + r.creditCents, 0));
  });
});
