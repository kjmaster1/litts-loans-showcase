import { desc, eq, gt } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { auth } from "@/server/auth/auth";
import { withInviteContext } from "@/server/auth/invite-context";
import { db } from "@/server/db";
import { auditEvent, user } from "@/server/db/schema";
import { completeInvite, createInvite, findPendingInvite, placeholderEmail } from "@/server/staff/invites";
import { resetDb } from "../support/db";
import { totp } from "../support/totp";

/**
 * End-to-end through Better Auth's real HTTP handler: proves each step of the
 * sign-in / enrolment / sign-out lifecycle lands in the audit log with the
 * right action and actor.
 */
const BASE = "http://localhost:3000/api/auth";
const PASSWORD = "audit trail lifecycle check 99";

class Browser {
  private jar = new Map<string, string>();
  async post(path: string, body: unknown) {
    const res = await auth.handler(
      new Request(`${BASE}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:3000",
          cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "),
        },
        body: JSON.stringify(body),
      }),
    );
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(";");
      const [name, value] = [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)];
      if (attrs.some((a) => /max-age=0/i.test(a)) || value === "") this.jar.delete(name);
      else this.jar.set(name, value);
    }
    return res;
  }
}

async function actionsSince(id: bigint) {
  const rows = await db.select().from(auditEvent).where(gt(auditEvent.id, id)).orderBy(auditEvent.id);
  return rows.map((r) => ({ action: r.action, actor: r.actorStaffId, method: (r.metadata as { method?: string }).method }));
}

async function lastId() {
  const [row] = await db.select({ id: auditEvent.id }).from(auditEvent).orderBy(desc(auditEvent.id)).limit(1);
  return row?.id ?? BigInt(0);
}

describe("auth events in the audit log", () => {
  let staffId: string;
  let secret: string;
  const browser = new Browser();

  beforeAll(async () => {
    await resetDb();
    const { token } = await createInvite({ stateId: 31337, characterName: "Audit Person", role: "loan_officer", actor: { type: "system" } });
    const invite = (await findPendingInvite(token))!;
    await withInviteContext(invite.inviteId, () =>
      auth.api.signUpEmail({ body: { email: placeholderEmail(invite.staffId), password: PASSWORD, name: "Audit Person", username: "audit.person" } }),
    );
    const u = (await db.query.user.findFirst({ where: eq(user.username, "audit.person") }))!;
    await completeInvite({ invite, userId: u.id });
    staffId = invite.staffId;
  });

  it("logs a password-only sign-in (before 2FA enrolment) as a sign-in", async () => {
    const since = await lastId();
    expect((await browser.post("/sign-in/username", { username: "audit.person", password: PASSWORD })).status).toBe(200);
    expect(await actionsSince(since)).toEqual([{ action: "auth.sign_in.succeeded", actor: staffId, method: "password_only" }]);
  });

  it("logs enrolment confirmation as '2FA enabled', not as a sign-in", async () => {
    const since = await lastId();
    const enabled = await browser.post("/two-factor/enable", { password: PASSWORD });
    const { totpURI } = (await enabled.json()) as { totpURI: string };
    secret = new URL(totpURI).searchParams.get("secret")!;
    expect((await browser.post("/two-factor/verify-totp", { code: totp(secret) })).status).toBe(200);
    expect((await actionsSince(since)).map((e) => e.action)).toEqual(["auth.2fa.enrollment_started", "auth.2fa.enabled"]);
  });

  it("attributes sign-out to the person signing out", async () => {
    const since = await lastId();
    await browser.post("/sign-out", {});
    expect(await actionsSince(since)).toEqual([{ action: "auth.sign_out", actor: staffId, method: undefined }]);
  });

  it("logs password-then-TOTP as 'password accepted' followed by 'signed in'", async () => {
    const since = await lastId();
    const first = await browser.post("/sign-in/username", { username: "audit.person", password: PASSWORD });
    expect(await first.json()).toMatchObject({ twoFactorRedirect: true });
    // The enrolment code's window was used already; use the next one (±1 step is accepted).
    expect((await browser.post("/two-factor/verify-totp", { code: totp(secret, 1) })).status).toBe(200);
    expect(await actionsSince(since)).toEqual([
      { action: "auth.sign_in.password_ok", actor: staffId, method: undefined },
      { action: "auth.sign_in.succeeded", actor: staffId, method: "totp" },
    ]);
  });

  it("logs a wrong code as a failed 2FA attempt", async () => {
    await browser.post("/sign-out", {});
    await browser.post("/sign-in/username", { username: "audit.person", password: PASSWORD });
    const since = await lastId();
    const wrong = totp(secret) === "000000" ? "111111" : "000000";
    expect((await browser.post("/two-factor/verify-totp", { code: wrong })).status).toBe(401);
    expect((await actionsSince(since)).map((e) => e.action)).toEqual(["auth.2fa.failed"]);
  });
});
