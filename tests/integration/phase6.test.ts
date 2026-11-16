import { readFileSync } from "node:fs";
import { desc, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/request", () => ({ getRequestMeta: async () => ({ ip: "203.0.113.10", userAgent: "vitest" }) }));

const { auth } = await import("@/server/auth/auth");
const { withInviteContext } = await import("@/server/auth/invite-context");
const { StepUpRequiredError } = await import("@/server/auth/step-up");
const { commitImport, cashBalanceCents, stageImport } = await import("@/server/bank/import");
const { closeLegacyClearing, legacyClearing } = await import("@/server/ledger/legacy");
const { resetTwoFactor } = await import("@/server/staff/service");
const { completeInvite, createInvite, findPendingInvite, placeholderEmail } = await import("@/server/staff/invites");
const { db } = await import("@/server/db");
const { account, auditEvent, session, staff, twoFactor, user } = await import("@/server/db/schema");
const { resetDb } = await import("../support/db");

type Viewer = import("@/server/authz/viewer").Viewer;
const BASE = "http://localhost:3000/api/auth";
const PASSWORD = "correct horse battery staple";

const request = (path: string, init: { method?: string; body?: unknown; cookie?: string } = {}) =>
  auth.handler(
    new Request(`${BASE}${path}`, {
      method: init.method ?? "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000", ...(init.cookie ? { cookie: init.cookie } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
  );

async function onboard(username: string, stateId: number) {
  const { token } = await createInvite({ stateId, characterName: `Test ${username}`, role: "loan_officer", actor: { type: "system" } });
  const invite = (await findPendingInvite(token))!;
  await withInviteContext(invite.inviteId, () =>
    auth.api.signUpEmail({ body: { email: placeholderEmail(invite.staffId), password: PASSWORD, name: invite.characterName, username } }),
  );
  const u = (await db.query.user.findFirst({ where: eq(user.username, username) }))!;
  await completeInvite({ invite, userId: u.id });
  return { userId: u.id, staffId: invite.staffId };
}

async function signIn(username: string) {
  const res = await request("/sign-in/username", { body: { username, password: PASSWORD } });
  const cookie = res.headers.get("set-cookie")!.match(/(litts\.session_token=[^;]+)/)![1];
  return cookie;
}

let ceo: Viewer;

beforeAll(async () => {
  await resetDb();
  const [row] = await db.insert(staff).values({ stateId: 424242, characterName: "Exec Tester", role: "ceo", status: "active" }).returning();
  ceo = { staffId: row.id, userId: "u", sessionId: "s", role: "ceo", characterName: row.characterName, stateId: row.stateId, username: "exec", twoFactorEnabled: true, stepUpAt: null, tourCompletedAt: null, tourRole: null };
});

describe("passkeys", () => {
  it("can only be added after a fresh step-up", async () => {
    const { userId } = await onboard("pk.user", 51001);
    const cookie = await signIn("pk.user");
    const refused = await request("/passkey/generate-register-options", { method: "GET", cookie });
    expect(refused.status).toBe(403);
    expect((await refused.json()).message).toBe("STEP_UP_REQUIRED");

    await db.update(user).set({ twoFactorEnabled: true }).where(eq(user.id, userId));
    await db.update(session).set({ stepUpAt: new Date() }).where(eq(session.userId, userId));
    const allowed = await request("/passkey/generate-register-options", { method: "GET", cookie });
    expect(allowed.status).toBe(200);
    const options = await allowed.json();
    expect(options.authenticatorSelection).toMatchObject({ userVerification: "required", residentKey: "required" });
    expect(options.rp).toMatchObject({ id: "localhost", name: "Litt's Loans" });
  });

  it("refuses a passkey sign-in where the device didn't verify the person, and records it", async () => {
    const flags = (f: number) => {
      const b = Buffer.alloc(37);
      b[32] = f;
      return b.toString("base64url");
    };
    const res = await request("/passkey/verify-authentication", {
      body: {
        response: {
          id: "abc",
          rawId: "abc",
          type: "public-key",
          response: { authenticatorData: flags(0x01), clientDataJSON: "e30", signature: "AA" },
          clientExtensionResults: {},
        },
      },
    });
    expect(res.status).toBe(401);
    const [event] = await db.select().from(auditEvent).orderBy(desc(auditEvent.id)).limit(1);
    expect(event).toMatchObject({ action: "auth.sign_in.failed" });
    expect(event.metadata).toMatchObject({ method: "passkey", error: "USER_NOT_VERIFIED" });
  });
});

describe("resetting someone's two-factor", () => {
  it("is for executives, needs a fresh step-up, and clears their 2FA and sessions", async () => {
    const target = await onboard("lost.phone", 51002);
    await signIn("lost.phone"); // a live session (before 2FA, a password alone signs in)
    await db.update(user).set({ twoFactorEnabled: true }).where(eq(user.id, target.userId));
    await db.insert(twoFactor).values({ id: crypto.randomUUID(), userId: target.userId, secret: "x", backupCodes: "y" });

    const officer = { ...ceo, role: "loan_officer" as const, stepUpAt: new Date().toISOString() };
    await expect(resetTwoFactor(officer, target.staffId, "Lost their phone")).rejects.toThrow(/permission/);
    await expect(resetTwoFactor(ceo, target.staffId, "Lost their phone")).rejects.toBeInstanceOf(StepUpRequiredError);

    await resetTwoFactor({ ...ceo, stepUpAt: new Date().toISOString() }, target.staffId, "Lost their phone; confirmed in person");
    const [u] = await db.select().from(user).where(eq(user.id, target.userId));
    expect(u.twoFactorEnabled).toBe(false);
    expect(await db.select().from(twoFactor).where(eq(twoFactor.userId, target.userId))).toHaveLength(0);
    expect(await db.select().from(session).where(eq(session.userId, target.userId))).toHaveLength(0);
    const [event] = await db.select().from(auditEvent).where(eq(auditEvent.action, "staff.two_factor.reset"));
    expect(event).toMatchObject({ reason: "Lost their phone; confirmed in person", targetId: target.staffId });
  });
});

describe("resetting someone's password", () => {
  it("issues a one-time link (executives, fresh step-up), sets the new password and signs them out", async () => {
    const { issuePasswordReset, findPasswordReset, completePasswordReset } = await import("@/server/staff/password-reset");
    const target = await onboard("forgot.pw", 51003);
    await signIn("forgot.pw");

    const officer = { ...ceo, role: "loan_officer" as const, stepUpAt: new Date().toISOString() };
    await expect(issuePasswordReset(officer, { staffId: target.staffId, reason: "Forgot it" })).rejects.toThrow(/permission/);
    await expect(issuePasswordReset(ceo, { staffId: target.staffId, reason: "Forgot it" })).rejects.toBeInstanceOf(StepUpRequiredError);

    const fresh = { ...ceo, stepUpAt: new Date().toISOString() };
    const first = await issuePasswordReset(fresh, { staffId: target.staffId, reason: "Forgot to save it at sign-up" });
    expect(await db.select().from(session).where(eq(session.userId, target.userId))).toHaveLength(0); // signed out now
    const { url, expiresAt } = await issuePasswordReset(fresh, { staffId: target.staffId, reason: "Lost the first link" });
    const token = (u: string) => u.split("/reset-password/")[1];
    expect(await findPasswordReset(token(first.url))).toBeNull(); // replaced
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(23 * 3_600_000);
    expect(await findPasswordReset(token(url))).toMatchObject({ staffId: target.staffId, username: "forgot.pw" });
    expect(await findPasswordReset("not-a-token")).toBeNull();

    await signIn("forgot.pw"); // the old password works until the new one is set
    const NEW = "a brand new passphrase 77";
    await completePasswordReset(token(url), NEW);
    expect(await db.select().from(session).where(eq(session.userId, target.userId))).toHaveLength(0);
    await expect(completePasswordReset(token(url), "another passphrase here")).rejects.toThrow(/invalid, expired or already used/);

    // (Checked against the stored hash: repeated sign-ins here would hit the rate limit.)
    const ctx = await auth.$context;
    const [login] = await db.select().from(account).where(eq(account.userId, target.userId));
    expect(await ctx.password.verify({ hash: login.password!, password: NEW })).toBe(true);
    expect(await ctx.password.verify({ hash: login.password!, password: PASSWORD })).toBe(false);

    const actions = (await db.select({ action: auditEvent.action }).from(auditEvent).where(eq(auditEvent.targetId, target.staffId))).map((a) => a.action);
    expect(actions.filter((a) => a === "staff.password_reset.issued")).toHaveLength(2);
    expect(actions).toContain("staff.password_reset.completed");

    // The break-glass CLI path: audited as the system, no issuing staff member.
    const { createPasswordReset } = await import("@/server/staff/password-reset");
    const [row] = await db.select().from(staff).where(eq(staff.id, target.staffId));
    const cli = await createPasswordReset({ target: row, reason: "No one above them can sign in", actor: { type: "system" } });
    expect(await findPasswordReset(token(cli.url))).toMatchObject({ staffId: target.staffId });
    const [event] = await db.select().from(auditEvent).where(eq(auditEvent.action, "staff.password_reset.issued")).orderBy(desc(auditEvent.occurredAt)).limit(1);
    expect(event).toMatchObject({ actorType: "system", actorStaffId: null, reason: "No one above them can sign in" });
  });
});

describe("the old manual loans", () => {
  beforeAll(async () => {
    await commitImport(ceo, await stageImport(ceo, { name: "export.xlsx", bytes: readFileSync("tests/fixtures/bank-export.xlsx") }));
  });

  it("shows what's left in clearing", async () => {
    expect(await legacyClearing()).toMatchObject({ balanceCents: -21_734_800, lentCents: 91_520_000, repaidCents: 113_254_800 });
  });

  it("books it once as income, with step-up and a reason", async () => {
    await expect(closeLegacyClearing(ceo, { reason: "All finished" })).rejects.toBeInstanceOf(StepUpRequiredError);
    const fresh = { ...ceo, stepUpAt: new Date().toISOString() };
    const cash = await cashBalanceCents();
    expect(await closeLegacyClearing(fresh, { reason: "All finished (owner confirmed)" })).toMatchObject({ amountCents: 21_734_800 });
    expect((await legacyClearing()).balanceCents).toBe(0);
    const income = Number((await db.execute(sql`select coalesce(sum(credit_cents - debit_cents), 0) as b from journal_line where account_code = '4020'`)).rows[0].b);
    expect(income).toBe(21_734_800);
    expect(await cashBalanceCents()).toBe(cash);
    await expect(closeLegacyClearing(fresh, { reason: "again please" })).rejects.toThrow(/nothing left/);
  });

  it("can be restated loan by loan, each in the month it finished (audit F7)", async () => {
    const { restateLegacyByLoan } = await import("@/server/ledger/legacy");
    const { reclassifyTransaction } = await import("@/server/bank/reclassify");
    const fresh = { ...ceo, stepUpAt: new Date().toISOString() };
    // As in production: Arlo's settlement payments ("Arlo Oswin" here) refiled as recoveries, close-out corrected.
    const arlo = (await db.execute<{ id: string }>(sql`select id from bank_transaction where comment ilike 'Charge Arlo Oswin%'`)).rows;
    for (const r of arlo) await reclassifyTransaction(ceo, { transactionId: r.id, category: "recovery.settlement", reason: "Settlement" });
    await closeLegacyClearing(fresh, { reason: "Arlo's payments refiled" });
    const preview = await restateLegacyByLoan(fresh, { reason: "Book each old loan when it finished", dryRun: true, overrides: [{ pattern: /last payment for loan|loan payment/i, loan: 34 }] });
    expect(preview.loans).toHaveLength(34);
    expect(preview.loans.reduce((s, l) => s + l.resultCents, 0)).toBe(21_734_800 - 4_037_600);
    const before = Number((await db.execute(sql`select count(*) as n from journal_entry`)).rows[0].n);
    expect(Number((await db.execute(sql`select count(*) as n from journal_entry`)).rows[0].n)).toBe(before); // dry run wrote nothing

    const { loans, reversed } = await restateLegacyByLoan(fresh, { reason: "Book each old loan when it finished", overrides: [{ pattern: /last payment for loan|loan payment/i, loan: 34 }] });
    expect(reversed).toBe(2); // the close-out and its correction
    expect((await legacyClearing()).balanceCents).toBe(0);
    const bal = async (code: string) => Number((await db.execute(sql`select coalesce(sum(debit_cents - credit_cents), 0) as b from journal_line where account_code = ${code}`)).rows[0].b);
    const profits = loans.filter((l) => l.resultCents > 0).reduce((s, l) => s + l.resultCents, 0);
    const losses = loans.filter((l) => l.resultCents < 0).reduce((s, l) => s - l.resultCents, 0);
    expect(-(await bal("4020"))).toBe(profits);
    expect(profits - losses).toBe(21_734_800 - 4_037_600);
    // 2025 now has income: loan #2 finished on 1 Mar 2025.
    const mar = await db.execute(sql`select count(*) as n from journal_entry where description = 'Old manual loan #2 closed out' and effective_at < '2025-03-02'`);
    expect(Number(mar.rows[0].n)).toBe(1);
    const tb = await db.execute(sql`select sum(debit_cents) = sum(credit_cents) as ok from journal_line`);
    expect(tb.rows[0].ok).toBe(true);
  });
});

describe("the old staff loans", () => {
  it("clears 2200 once: unpaid lenders as settled outside the wallet, over-repayment as interest", async () => {
    const { staffLoans, closeStaffLoans } = await import("@/server/ledger/staff-loans");
    const before = await staffLoans();
    // The fixture predates the last staff loan, so it owes less than production.
    expect(before.balanceCents).toBeGreaterThan(0);
    expect(before.lenders.reduce((s, l) => s + l.balanceCents, 0)).toBe(before.balanceCents);
    expect(before.lenders.filter((l) => l.balanceCents < 0).map((l) => l.balanceCents)).toEqual([-581_400]); // repaid $5,814 more than lent

    await expect(closeStaffLoans(ceo, { reason: "All finished" })).rejects.toBeInstanceOf(StepUpRequiredError);
    const fresh = { ...ceo, stepUpAt: new Date().toISOString() };
    const cash = await cashBalanceCents();
    await closeStaffLoans(fresh, { reason: "All staff loans finished (owner)" });
    const bal = async (code: string) => Number((await db.execute(sql`select coalesce(sum(debit_cents - credit_cents), 0) as b from journal_line where account_code = ${code}`)).rows[0].b);
    expect(await bal("2200")).toBe(0);
    expect(await bal("5150")).toBe(581_400);
    expect(await cashBalanceCents()).toBe(cash);
    await expect(closeStaffLoans(fresh, { reason: "again please" })).rejects.toThrow(/nothing to clear/);
  });
});
