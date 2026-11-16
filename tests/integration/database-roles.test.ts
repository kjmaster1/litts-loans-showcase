import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

const { db } = await import("@/server/db");

/**
 * The least-privilege roles (migration 0030, review 2026-10-13). `litts_app` is what the live app connects as;
 * `litts_readonly` is for backups and checks. The test database's user is a superuser, so it can act as either.
 */

/** Tables whose rows a trigger refuses to delete: the append-only ones, plus the raw bank rows and allowance readings. */
async function guardedTables(): Promise<string[]> {
  const rows = await db.execute<{ name: string }>(sql`
    select distinct c.relname as name from pg_trigger t join pg_class c on c.oid = t.tgrelid
     where not t.tgisinternal and (t.tgtype & 8) <> 0 and c.relnamespace = 'public'::regnamespace order by 1`);
  return rows.rows.map((r) => r.name);
}

const privilege = async (role: string, table: string, what: string) =>
  (await db.execute<{ ok: boolean }>(sql`select has_table_privilege(${role}, ${`public.${table}`}, ${what}) as ok`)).rows[0].ok;

/** Runs `statement` as `role` inside a transaction that's always rolled back; returns the error message, if any. */
async function asRole(role: "litts_app" | "litts_readonly", statement: ReturnType<typeof sql>): Promise<string | null> {
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`set local role ${role}`));
      await tx.execute(statement);
      throw new Error("ROLLBACK");
    });
  } catch (error) {
    const message = ((error as { cause?: { message?: string } }).cause?.message ?? (error as Error).message) || "";
    return message === "ROLLBACK" ? null : message;
  }
  return null;
}

describe("the app's database role", () => {
  it("can't change or remove rows of any table a trigger protects", async () => {
    const guarded = await guardedTables();
    expect(guarded).toEqual(expect.arrayContaining(["audit_event", "journal_entry", "journal_line", "bank_transaction", "loan_event"]));
    for (const table of guarded) {
      expect(await privilege("litts_app", table, "DELETE"), `${table} DELETE`).toBe(false);
      expect(await privilege("litts_app", table, "TRUNCATE"), `${table} TRUNCATE`).toBe(false);
      // Reclassifying a bank row and voiding an allowance reading are updates the triggers allow.
      if (table !== "bank_transaction" && table !== "allowance_reading") expect(await privilege("litts_app", table, "UPDATE"), `${table} UPDATE`).toBe(false);
    }
  });

  it("reads and writes every other table", async () => {
    for (const table of ["loan", "mortgage", "staff", "session", "rate_limit", "commission_week"]) {
      for (const what of ["SELECT", "INSERT", "UPDATE", "DELETE"]) expect(await privilege("litts_app", table, what), `${table} ${what}`).toBe(true);
    }
  });

  it("can't switch the triggers off or change the schema", async () => {
    expect(await asRole("litts_app", sql`alter table journal_entry disable trigger journal_entry_immutable`)).toMatch(/must be (the )?owner/);
    expect(await asRole("litts_app", sql`create table sneaky (id int)`)).toMatch(/permission denied/);
    expect(await asRole("litts_app", sql`delete from audit_event`)).toMatch(/permission denied/);
    expect(await asRole("litts_app", sql`select count(*) from loan`)).toBeNull();
  });
});

describe("the read-only role", () => {
  it("reads everything and writes nothing", async () => {
    expect(await asRole("litts_readonly", sql`select count(*) from audit_event`)).toBeNull();
    expect(await asRole("litts_readonly", sql`select count(*) from drizzle.__drizzle_migrations`)).toBeNull();
    expect(await asRole("litts_readonly", sql`delete from rate_limit`)).toMatch(/permission denied/);
    expect(await privilege("litts_readonly", "loan", "INSERT")).toBe(false);
  });
});
