import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/request", () => ({ getRequestMeta: async () => ({ ip: "203.0.113.10", userAgent: "vitest" }) }));

const { getSettings, saveSettings, settingsHistory } = await import("@/server/settings");
const { DEFAULT_SETTINGS } = await import("@/domain/settings");
const { StepUpRequiredError } = await import("@/server/auth/step-up");
const { db } = await import("@/server/db");
const { auditEvent, staff } = await import("@/server/db/schema");
const { resetDb } = await import("../support/db");

type Viewer = import("@/server/authz/viewer").Viewer;
let ceo: Viewer;
let manager: Viewer;

async function makeViewer(stateId: number, name: string, role: Viewer["role"]): Promise<Viewer> {
  const [row] = await db.insert(staff).values({ stateId, characterName: name, role, status: "active" }).returning();
  return { staffId: row.id, userId: `u-${stateId}`, sessionId: `s-${stateId}`, role, characterName: name, stateId, username: name, twoFactorEnabled: true, stepUpAt: null, tourCompletedAt: null, tourRole: null };
}

beforeAll(async () => {
  await resetDb();
  ceo = await makeViewer(434343, "Settings CEO", "ceo");
  manager = await makeViewer(535353, "Settings Manager", "management");
});

describe("company settings", () => {
  const raised = { ...DEFAULT_SETTINGS, commission: { ...DEFAULT_SETTINGS.commission, mortgagePoolPct: 35 }, loans: { ...DEFAULT_SETTINGS.loans, writeOffAfterDays: 21 } };

  it("starts from the original rates", async () => {
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
    expect(await settingsHistory()).toEqual([]);
  });

  it("needs Owner/CEO/COO, a fresh authenticator code, a reason and a real change", async () => {
    const fresh = new Date().toISOString();
    await expect(saveSettings({ ...manager, stepUpAt: fresh }, { values: raised, reason: "Raise the pool" })).rejects.toThrow(/permission/);
    await expect(saveSettings(ceo, { values: raised, reason: "Raise the pool" })).rejects.toBeInstanceOf(StepUpRequiredError);
    await expect(saveSettings({ ...ceo, stepUpAt: fresh }, { values: raised, reason: "no" })).rejects.toThrow(/reason/);
    await expect(saveSettings({ ...ceo, stepUpAt: fresh }, { values: DEFAULT_SETTINGS, reason: "Nothing really" })).rejects.toThrow(/Nothing has changed/);
    const bad = { ...DEFAULT_SETTINGS, commission: { ...DEFAULT_SETTINGS.commission, mortgagePoolPct: 90 } };
    await expect(saveSettings({ ...ceo, stepUpAt: fresh }, { values: bad, reason: "Too much" })).rejects.toThrow(/more than 100%/);
  });

  it("saves a new version, keeps the history and audits the change", async () => {
    expect(await saveSettings({ ...ceo, stepUpAt: new Date().toISOString() }, { values: raised, reason: "Raise the pool" })).toEqual({ changes: 2 });
    expect(await getSettings()).toEqual(raised);
    const [h] = await settingsHistory();
    expect(h).toMatchObject({ by: "Settings CEO", reason: "Raise the pool" });
    expect(h.changes).toEqual([
      { path: "commission.mortgagePoolPct", from: 30, to: 35 },
      { path: "loans.writeOffAfterDays", from: 28, to: 21 },
    ]);
    const [a] = await db.select().from(auditEvent).where(eq(auditEvent.action, "settings.changed"));
    expect(a.reason).toBe("Raise the pool");
    await expect(db.execute(sql`update company_setting set reason = 'x'`)).rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringMatching(/immutable|append-only/) }) });
  });
});

describe("full data export", () => {
  it("has one sheet per business table and no sign-in secrets", async () => {
    const XLSX = await import("xlsx");
    const { fullExport, EXPORT_TABLES } = await import("@/server/export");
    const { bytes, rows } = await fullExport();
    const wb = XLSX.read(bytes, { type: "buffer" });
    expect(wb.SheetNames).toEqual([...EXPORT_TABLES]);
    expect(rows).toBeGreaterThan(0);
    for (const secret of ["user", "account", "session", "two_factor", "passkey", "verification", "staff_invite", "rate_limit"]) {
      expect(wb.SheetNames).not.toContain(secret);
    }
    const header = XLSX.utils.sheet_to_json<string[]>(wb.Sheets.staff, { header: 1 })[0];
    expect(header).toContain("character_name");
    expect(header.some((h) => /password|secret|token/i.test(h))).toBe(false);
  });

  it("covers every table in the database, or says why it doesn't (review 2026-10-13)", async () => {
    const { EXPORT_TABLES, NOT_EXPORTED } = await import("@/server/export");
    const tables = (await db.execute<{ name: string }>(sql`select table_name as name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`)).rows.map((r) => r.name);
    const exported = new Set<string>(EXPORT_TABLES);
    const skipped = new Set(Object.keys(NOT_EXPORTED));
    expect(tables.filter((t) => !exported.has(t) && !skipped.has(t))).toEqual([]);
    expect([...exported].filter((t) => skipped.has(t))).toEqual([]);
    expect([...exported, ...skipped].filter((t) => !tables.includes(t))).toEqual([]);
  });
});
