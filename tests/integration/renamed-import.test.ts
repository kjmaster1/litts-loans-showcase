import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq, isNull, sql } from "drizzle-orm";
import * as XLSX from "xlsx";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/request", () => ({ getRequestMeta: async () => ({ ip: "203.0.113.10", userAgent: "vitest" }) }));

const { cashBalanceCents, commitImport, getImportPreview, stageImport } = await import("@/server/bank/import");
const { commitTablet } = await import("@/server/mortgages/tablet");
const { mortgageSyncPending, syncMortgages } = await import("@/server/mortgages/sync");
const { db } = await import("@/server/db");
const { bankTransaction, mortgage, mortgageSnapshot, staff } = await import("@/server/db/schema");
const { resetDb } = await import("../support/db");

/**
 * A renamed customer (QA 2026-10-13, "Later the same day"). The bank export shows each person's current name on all
 * their rows, old ones too. Cyan Oakhurst became Cyan Spencer and her down payment and repayment were imported again.
 * The import now recognises rows without the name; migration 0028 removes duplicates that got in before.
 */

const FIXTURE = readFileSync("tests/fixtures/bank-export.xlsx");
const REPORTED = 18_533_100;
const ADDRESS = "118 Imagination Ct";
/** The fixture's tablet agreement, moved to this address and buyer (the matching is by address). */
const AGREEMENT = readFileSync("tests/fixtures/paste-mortgage.txt", "utf8").replace("117 Invention Ct", ADDRESS).replace("#1632 Jordan Ironside", "#16754 Cyan Oakhurst");
const COL = { time: 0, amount: 2, name: 6, stateId: 7, comment: 8 };
const MIGRATION = readFileSync("drizzle/0028_renamed_duplicates.sql", "utf8")
  .split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter(Boolean);

let viewer: import("@/server/authz/viewer").Viewer;

function grid() {
  const wb = XLSX.read(FIXTURE, { type: "buffer" });
  const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, blankrows: true, defval: null });
  return { name: wb.SheetNames[0], head: rows.slice(0, 6), data: rows.slice(6).filter((r) => r.some((c) => c !== null)) };
}

function exportOf(rows: unknown[][]): Uint8Array {
  const g = grid();
  const out = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(out, XLSX.utils.aoa_to_sheet([...g.head, ...rows]), g.name);
  return XLSX.write(out, { type: "buffer", bookType: "xlsx" });
}

/** The buyer's rows on the address (down payment and repayment), under a new name. */
function renamedBuyerRows(newName: string) {
  const ours = grid().data.filter((r) => typeof r[COL.comment] === "string" && (r[COL.comment] as string).startsWith(ADDRESS) && r[COL.stateId] !== 101);
  expect(ours.length).toBeGreaterThanOrEqual(2);
  return ours.map((r) => r.map((c, i) => (i === COL.name ? newName : c)));
}

async function preview(bytes: Uint8Array) {
  const stagingId = await stageImport(viewer, { name: "export.xlsx", bytes });
  return { stagingId, preview: await getImportPreview(viewer, stagingId) };
}

const liveAt = () => db.select().from(mortgage).where(and(eq(mortgage.address, ADDRESS), isNull(mortgage.mergedIntoId)));
const balanced = async () => (await db.execute<{ ok: boolean }>(sql`select sum(debit_cents) = sum(credit_cents) as ok from journal_line`)).rows[0].ok;

beforeAll(async () => {
  await resetDb();
  const [row] = await db.insert(staff).values({ stateId: 454545, characterName: "Rename Tester", role: "ceo", status: "active" }).returning();
  viewer = { staffId: row.id, userId: "u", sessionId: "s", role: "ceo", characterName: row.characterName, stateId: row.stateId, username: "rename.tester", twoFactorEnabled: true, stepUpAt: null, tourCompletedAt: null, tourRole: null };
  const { stagingId } = await preview(FIXTURE);
  await commitImport(viewer, stagingId);
  await commitTablet(viewer, { text: AGREEMENT });
});

describe("importing an export after a customer changed name", () => {
  it("recognises their old rows and adds nothing", async () => {
    const { stagingId, preview: p } = await preview(exportOf(renamedBuyerRows("Renamed Buyer")));
    expect(p.newRows).toBe(0);
    expect(p.backdated).toEqual([]);
    expect(await commitImport(viewer, stagingId)).toMatchObject({ newRows: 0 });
    expect(await cashBalanceCents()).toBe(REPORTED);
    expect(await liveAt()).toHaveLength(1);
  });

  it("reconciles the full export as at its own last row", async () => {
    const { preview: p } = await preview(FIXTURE);
    expect(p.cashAtExportCents).toBe(REPORTED);
  });

  it("warns in red when a new row is older than the books, and the balance won't match", async () => {
    const [template] = renamedBuyerRows("Someone");
    const extra = [...template];
    extra[COL.comment] = "A payment nobody imported";
    extra[COL.amount] = 1234;
    const { preview: p } = await preview(exportOf([extra]));
    expect(p.newRows).toBe(1);
    expect(p.backdated).toHaveLength(1);
    expect(p.cashAtExportCents).not.toBe(p.reportedBalanceCents);
  });
});

describe("migration 0028: duplicates imported before the fix", () => {
  /** What the old import did: the buyer's rows stored again under the new name, posted, and synced. */
  async function importTwiceTheOldWay() {
    const batchId = randomUUID();
    await db.execute(sql`insert into import_batch (id, kind, file_name, file_sha256, wallet_id, export_timezone, reported_balance_cents, row_count, new_count, duplicate_count, ruleset_version, created_at)
      values (${batchId}, 'bank_xlsx', 'renamed.xlsx', 'x', '69811362', 'UTC-5', ${REPORTED}, 2, 2, 0, 1, now() + interval '1 minute')`);
    const originals = await db
      .select()
      .from(bankTransaction)
      .where(and(sql`${bankTransaction.comment} like ${ADDRESS + ":%"}`, sql`${bankTransaction.initiatorStateId} <> 101`, eq(bankTransaction.direction, "in")));
    expect(originals.length).toBeGreaterThanOrEqual(2);
    await db.transaction(async (tx) => {
      for (const o of originals) {
        const id = randomUUID();
        const entryId = randomUUID();
        await tx.insert(bankTransaction).values({ ...o, id, batchId, initiatorName: "Renamed Buyer", fingerprint: `renamed-${o.fingerprint}`, postingEntryId: entryId, createdAt: new Date() });
        await tx.execute(sql`insert into journal_entry (id, effective_at, kind, description, bank_transaction_id, batch_id)
          select ${entryId}, effective_at, kind, description, ${id}, ${batchId} from journal_entry where id = ${o.postingEntryId}`);
        await tx.execute(sql`insert into journal_line (entry_id, account_code, debit_cents, credit_cents, memo)
          select ${entryId}, account_code, debit_cents, credit_cents, memo from journal_line where entry_id = ${o.postingEntryId}`);
      }
    });
    await syncMortgages();
    return originals.length;
  }

  it("removes the duplicate rows and postings and retires the second mortgage into the first, keeping the newer paste", async () => {
    const [original] = await liveAt();
    const n = await importTwiceTheOldWay();
    expect(await cashBalanceCents()).toBeGreaterThan(REPORTED);
    expect(await liveAt()).toHaveLength(2);
    // The agreement pasted again lands on one of the two.
    await commitTablet(viewer, { text: AGREEMENT });
    const latestPaste = (await db.execute<{ t: string }>(sql`select max(last_tablet_at)::text as t from mortgage where address = ${ADDRESS}`)).rows[0].t;

    await db.transaction(async (tx) => {
      for (const s of MIGRATION) await tx.execute(sql.raw(s));
    });

    expect(await cashBalanceCents()).toBe(REPORTED);
    expect(await balanced()).toBe(true);
    const live = await liveAt();
    expect(live).toHaveLength(1);
    expect(live[0].id).toBe(original.id);
    expect(live[0].lastTabletAt?.getTime()).toBe(new Date(latestPaste).getTime());
    expect(await db.select().from(mortgageSnapshot).where(eq(mortgageSnapshot.mortgageId, original.id))).toHaveLength(2);
    const { rows: links } = await db.execute<{ n: number }>(sql`select count(*)::int as n from mortgage_payment p join bank_transaction b on b.id = p.bank_transaction_id
      where p.mortgage_id = ${original.id} and b.initiator_name = 'Renamed Buyer'`);
    expect(links[0].n).toBe(0);
    const { rows: batch } = await db.execute<{ new_count: number; duplicate_count: number }>(sql`select new_count, duplicate_count from import_batch where file_name = 'renamed.xlsx'`);
    expect(batch[0]).toMatchObject({ new_count: 2 - n, duplicate_count: n });
    expect(await mortgageSyncPending()).toBe(false);
    expect(await syncMortgages()).toMatchObject({ created: 0, merged: 0, paymentsLinked: 0 });
  });

  it("changes nothing when run again", async () => {
    const before = await cashBalanceCents();
    await db.transaction(async (tx) => {
      for (const s of MIGRATION) await tx.execute(sql.raw(s));
    });
    expect(await cashBalanceCents()).toBe(before);
    expect(await liveAt()).toHaveLength(1);
  });
});
