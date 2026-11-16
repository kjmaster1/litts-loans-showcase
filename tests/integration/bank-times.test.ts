import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/request", () => ({ getRequestMeta: async () => ({ ip: "203.0.113.10", userAgent: "vitest" }) }));

const { commitImport, getImportPreview, stageImport } = await import("@/server/bank/import");
const { trialBalance } = await import("@/server/ledger/queries");
const { db } = await import("@/server/db");
const { staff } = await import("@/server/db/schema");
const { resetDb } = await import("../support/db");

/**
 * Migration 0024 (ADR 0004): bank times were stored 5 hours late because the export's "UTC-5" label was
 * believed. The migration moves them, and every time copied from them, back — and nothing else.
 */

const FIXTURE = readFileSync("tests/fixtures/bank-export.xlsx");
const MIGRATION = readFileSync("drizzle/0024_bank_times_utc.sql", "utf8")
  .split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter(Boolean);
const FIVE_HOURS = "interval '5 hours'";

let viewer: import("@/server/authz/viewer").Viewer;

async function importFixture() {
  const stagingId = await stageImport(viewer, { name: "export.xlsx", bytes: FIXTURE });
  await getImportPreview(viewer, stagingId);
  return commitImport(viewer, stagingId);
}

async function runMigration() {
  await db.transaction(async (tx) => {
    for (const statement of MIGRATION) await tx.execute(sql.raw(statement));
  });
}

type Snapshot = Record<string, string | null>;
/** Every time the correction may touch, keyed by table and id. */
async function times(): Promise<Snapshot> {
  const { rows } = await db.execute<{ k: string; t: string | null }>(sql`
    select 'bank:' || id as k, occurred_at::text as t from bank_transaction
    union all select 'entry:' || id, effective_at::text from journal_entry
    union all select 'loan-open:' || id, opened_at::text from loan
    union all select 'loan-done:' || id, completed_at::text from loan
    union all select 'loan-default:' || id, first_default_at::text from loan
    union all select 'mortgage:' || id, originated_at::text from mortgage
    union all select 'batch:' || id, first_tx_at::text || ' ' || last_tx_at::text from import_batch`);
  return Object.fromEntries(rows.map((r) => [r.k, r.t]));
}

/** Puts the database back the way the old parser left it: every bank time, and each copy of it, 5 hours late. */
async function makeTimesLate() {
  await db.transaction(async (tx) => {
    await tx.execute(sql`set local session_replication_role = replica`);
    await tx.execute(sql.raw(`update journal_entry e set effective_at = effective_at + ${FIVE_HOURS}
      where exists (select 1 from bank_transaction b where b.occurred_at = e.effective_at)`));
    await tx.execute(sql.raw(`update loan l set opened_at = opened_at + ${FIVE_HOURS} from bank_transaction b where b.id = l.disbursement_tx_id`));
    await tx.execute(sql.raw(`update loan l set completed_at = completed_at + ${FIVE_HOURS}
      where exists (select 1 from loan_payment_link k join bank_transaction b on b.id = k.bank_transaction_id where k.loan_id = l.id and b.occurred_at = l.completed_at)`));
    await tx.execute(sql.raw(`update mortgage m set originated_at = originated_at + ${FIVE_HOURS} from bank_transaction b where b.id = m.origination_tx_id`));
    await tx.execute(sql.raw(`update import_batch set first_tx_at = first_tx_at + ${FIVE_HOURS}, last_tx_at = last_tx_at + ${FIVE_HOURS}`));
    await tx.execute(sql.raw(`update bank_transaction set occurred_at = occurred_at + ${FIVE_HOURS}`));
  });
}

beforeAll(async () => {
  await resetDb();
  const [row] = await db.insert(staff).values({ stateId: 434343, characterName: "Clock Tester", role: "ceo", status: "active" }).returning();
  viewer = { staffId: row.id, userId: "u", sessionId: "s", role: "ceo", characterName: row.characterName, stateId: row.stateId, username: "clock.tester", twoFactorEnabled: true, stepUpAt: null, tourCompletedAt: null, tourRole: null };
  await importFixture();
});

describe("bank time correction (migration 0024)", () => {
  it("moves bank times and their copies back 5 hours, and leaves the app's own times alone", async () => {
    // Two loans with a default date: one estimated from a bank time (+ 3 weeks), one from the card (already right).
    const { rows: loans } = await db.execute<{ id: string; opened_at: string }>(sql`
      select id, opened_at::text from loan where disbursement_tx_id is not null and opened_at is not null order by opened_at limit 2`);
    expect(loans).toHaveLength(2);
    await db.execute(sql`update loan set first_default_at = opened_at + interval '21 days' where id = ${loans[0].id}`);
    await db.execute(sql`update loan set first_default_at = opened_at + interval '14 days 1234 seconds' where id = ${loans[1].id}`);

    const correct = await times();
    const tbBefore = await trialBalance();

    await makeTimesLate();
    // The estimate was made from the late start, so it is late too; the card's date (loans[1]) was right all along.
    await db.execute(sql`update loan set first_default_at = opened_at + interval '21 days' where id = ${loans[0].id}`);
    // Entries the app dates itself: a week close at a second that equals a (late) bank time, and a write-off at "now".
    const { rows: [bank] } = await db.execute<{ at: string }>(sql`select occurred_at::text as at from bank_transaction order by occurred_at desc limit 1`);
    const { weekClose, writeOff } = await db.transaction(async (tx) => {
      const entry = async (at: string | null, description: string, debit: string, credit: string) => {
        const { rows: [e] } = await tx.execute<{ id: string }>(sql`
          insert into journal_entry (effective_at, kind, description) values (coalesce(${at}::timestamptz, now()), 'adjustment', ${description}) returning id`);
        await tx.execute(sql`insert into journal_line (entry_id, account_code, debit_cents, credit_cents, memo) values
          (${e.id}, ${debit}, 1, 0, 't'), (${e.id}, ${credit}, 0, 1, 't')`);
        return e.id;
      };
      return { weekClose: await entry(bank.at, "Commission — week of 5 Oct", "5000", "2000"), writeOff: await entry(null, "Loan written off", "5300", "1100") };
    });
    const appTimes = await db.execute<{ id: string; t: string }>(sql`select id, effective_at::text as t from journal_entry where id in (${weekClose}, ${writeOff})`);
    // The late state really is late: every bank row, its posting, each loan start and each mortgage start.
    const late = await times();
    const moved = (prefix: string) => Object.keys(correct).filter((k) => k.startsWith(prefix) && correct[k] !== null && late[k] !== correct[k]).length;
    expect(moved("bank:")).toBe(1922);
    expect(moved("entry:")).toBeGreaterThanOrEqual(1922);
    expect(moved("loan-open:")).toBeGreaterThan(0);
    expect(moved("mortgage:")).toBeGreaterThan(0);
    expect(moved("loan-default:")).toBe(1);

    await runMigration();

    const after = await times();
    for (const [k, t] of Object.entries(correct)) expect([k, after[k]]).toEqual([k, t]);
    const kept = await db.execute<{ id: string; t: string }>(sql`select id, effective_at::text as t from journal_entry where id in (${weekClose}, ${writeOff})`);
    expect(new Map(kept.rows.map((r) => [r.id, r.t]))).toEqual(new Map(appTimes.rows.map((r) => [r.id, r.t])));

    // Money is untouched (the two test entries add 1 cent each side).
    const tbAfter = await trialBalance();
    const sum = (tb: typeof tbBefore, f: "debitCents" | "creditCents") => tb.reduce((s, r) => s + r[f], 0);
    expect(sum(tbAfter, "debitCents")).toBe(sum(tbBefore, "debitCents") + 2);
    expect(sum(tbAfter, "creditCents")).toBe(sum(tbBefore, "creditCents") + 2);

    // The ledger and raw bank rows are protected again.
    await expect(db.execute(sql`update journal_entry set description = 'x' where id = ${weekClose}`)).rejects.toThrow();
    await expect(db.execute(sql`update bank_transaction set occurred_at = occurred_at - interval '1 hour'`)).rejects.toThrow();

    // Re-importing the same export still recognises every row: fingerprints didn't change.
    const again = await importFixture();
    expect(again.newRows).toBe(0);
  });

  it("refuses to run when loan interest would land, uncounted, in the closed catch-up period", async () => {
    const { rows: [link] } = await db.execute<{ id: string }>(sql`
      select b.id from bank_transaction b join loan_payment_link k on k.bank_transaction_id = b.id where k.role = 'interest' limit 1`);
    const before = await times();
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local session_replication_role = replica`);
      await tx.execute(sql`update bank_transaction set occurred_at = '2026-10-12 01:00:00+00' where id = ${link.id}`);
      await tx.execute(sql`insert into commission_week (week_key, status) values ('catch-up', 'closed')`);
    });
    await expect(runMigration()).rejects.toThrow(/closed catch-up period/);
    const { rows: [still] } = await db.execute<{ t: string }>(sql`select occurred_at::text as t from bank_transaction where id = ${link.id}`);
    expect(new Date(still.t).toISOString()).toBe("2026-10-12T01:00:00.000Z");
    const now = await times();
    for (const [k, t] of Object.entries(before)) if (k !== `bank:${link.id}`) expect([k, now[k]]).toEqual([k, t]);
  });
});

describe("event time correction (migration 0026)", () => {
  const EVENTS = readFileSync("drizzle/0026_event_times_utc.sql", "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);
  const run = () => db.transaction(async (tx) => {
    for (const statement of EVENTS) await tx.execute(sql.raw(statement));
  });
  const eventTimes = async () =>
    (await db.execute<{ k: string; t: string }>(sql`
      select 'loan:' || id as k, at::text as t from loan_event where kind = 'disbursed'
      union all select 'mortgage:' || id, at::text from mortgage_event where kind = 'originated' order by 1`)).rows;

  it("moves a loan's disbursed and a mortgage's originated event back to their bank rows' times, once", async () => {
    const correct = await eventTimes();
    expect(correct.filter((r) => r.k.startsWith("loan:")).length).toBeGreaterThan(0);
    expect(correct.filter((r) => r.k.startsWith("mortgage:")).length).toBeGreaterThan(0);
    // As the old parser left them: dated from the bank row 5 hours late.
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local session_replication_role = replica`);
      await tx.execute(sql`update loan_event set at = at + interval '5 hours' where kind = 'disbursed'`);
      await tx.execute(sql`update mortgage_event set at = at + interval '5 hours' where kind = 'originated'`);
    });
    expect(await eventTimes()).not.toEqual(correct);
    await run();
    expect(await eventTimes()).toEqual(correct);
    await run();
    expect(await eventTimes()).toEqual(correct);
    // Append-only again.
    await expect(db.execute(sql`update loan_event set at = now() where kind = 'disbursed'`)).rejects.toThrow();
    await expect(db.execute(sql`update mortgage_event set at = now() where kind = 'originated'`)).rejects.toThrow();
  });
});
