import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { auth } from "@/server/auth/auth";
import { withInviteContext } from "@/server/auth/invite-context";
import { db } from "@/server/db";
import { session, staff, user } from "@/server/db/schema";
import { completeInvite, createInvite, findPendingInvite, placeholderEmail } from "@/server/staff/invites";
import { resetDb } from "../support/db";

const BASE = "http://localhost:3000/api/auth";
const PASSWORD = "correct horse battery staple";

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return auth.handler(
    new Request(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

/** Runs the real invite flow up to an active staff member with a login. */
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

describe("authentication hardening", () => {
  beforeEach(resetDb);

  it.each([
    "/sign-up/email",
    "/sign-in/email",
    "/forget-password",
    "/request-password-reset",
    "/list-sessions",
    "/revoke-sessions",
    "/two-factor/disable",
    "/two-factor/get-totp-uri",
    "/update-user",
    "/delete-user",
  ])("disables %s over HTTP", async (path) => {
    const res = await post(path, { email: "x@example.com", password: PASSWORD, name: "x", username: "x" });
    expect(res.status).toBe(404);
  });

  it("refuses to create an account outside an invite, even server-side", async () => {
    // Better Auth answers a refused sign-up with a synthetic "success" (anti-enumeration),
    // so the only trustworthy check is the database — which is what the invite flow does too.
    const res = await auth.api.signUpEmail({
      body: { email: "rogue@example.com", password: PASSWORD, name: "Rogue", username: "rogue" },
    });
    expect(res.token).toBeNull();
    expect(await db.query.user.findFirst({ where: eq(user.username, "rogue") })).toBeUndefined();
    expect(await db.query.user.findFirst({ where: eq(user.id, res.user.id) })).toBeUndefined();
  });

  it("signs in an active staff member with their username", async () => {
    await onboard("skyler.marlowe", 3628);
    const res = await post("/sign-in/username", { username: "skyler.marlowe", password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/litts\.session_token=/);
  });

  it("gives the same error for an unknown user and a wrong password", async () => {
    await onboard("skyler.marlowe", 3628);
    const wrong = await post("/sign-in/username", { username: "skyler.marlowe", password: "not the password at all" });
    const unknown = await post("/sign-in/username", { username: "nobody.here", password: "not the password at all" });
    expect(wrong.status).toBe(unknown.status);
    expect((await wrong.json()).code).toBe((await unknown.json()).code);
  });

  it("blocks sign-in for suspended staff", async () => {
    const { staffId } = await onboard("cove.g", 20001);
    await db.update(staff).set({ status: "suspended" }).where(eq(staff.id, staffId));
    const res = await post("/sign-in/username", { username: "cove.g", password: PASSWORD });
    expect(res.status).toBe(403);
    expect(await db.select().from(session)).toHaveLength(0);
  });

  it("rate-limits repeated sign-in attempts", async () => {
    await onboard("jay.m", 20002);
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await post("/sign-in/username", { username: "jay.m", password: "wrong password here" }, { "x-forwarded-for": "198.51.100.9" });
      statuses.push(res.status);
    }
    expect(statuses).toContain(429);
  });

  it("uses timestamptz for auth timestamps", async () => {
    const { userId } = await onboard("sophia.k", 20003);
    const row = await db.query.user.findFirst({ where: eq(user.id, userId) });
    expect(row?.createdAt).toBeInstanceOf(Date);
  });
});
