import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { staff, staffInvite, user } from "@/server/db/schema";
import { completeInvite, createInvite, findPendingInvite, hashInviteToken } from "@/server/staff/invites";
import { resetDb } from "../support/db";

const system = { type: "system" } as const;

async function fakeUser(id: string) {
  await db.insert(user).values({ id, name: id, email: `${id}@test.invalid`, username: id });
  return id;
}

describe("staff invites", () => {
  beforeEach(resetDb);

  it("stores only a hash of the token", async () => {
    const { token, staffId } = await createInvite({ stateId: 3454, characterName: "Kieran Jones", role: "ceo", actor: system });
    const rows = await db.select().from(staffInvite).where(eq(staffInvite.staffId, staffId));
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toBe(hashInviteToken(token));
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it("finds a pending invite and is single-use", async () => {
    const { token } = await createInvite({ stateId: 3454, characterName: "Kieran Jones", role: "ceo", actor: system });
    const invite = await findPendingInvite(token);
    expect(invite).toMatchObject({ stateId: 3454, role: "ceo", characterName: "Kieran Jones" });

    await completeInvite({ invite: invite!, userId: await fakeUser("u1") });
    expect(await findPendingInvite(token)).toBeNull();
    await expect(completeInvite({ invite: invite!, userId: await fakeUser("u2") })).rejects.toThrow(/already been used/);

    const member = await db.query.staff.findFirst({ where: eq(staff.id, invite!.staffId) });
    expect(member).toMatchObject({ status: "active", userId: "u1" });
  });

  it("rejects malformed, unknown and expired tokens", async () => {
    expect(await findPendingInvite("short")).toBeNull();
    expect(await findPendingInvite("A".repeat(43))).toBeNull();

    const { token, staffId } = await createInvite({ stateId: 25512, characterName: "Sage Dunmore", role: "owner", actor: system });
    await db.update(staffInvite).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(staffInvite.staffId, staffId));
    expect(await findPendingInvite(token)).toBeNull();
  });

  it("re-issuing revokes the previous link", async () => {
    const first = await createInvite({ stateId: 20035, characterName: "Zion Pemberton", role: "coo", actor: system });
    const second = await createInvite({ stateId: 20035, characterName: "Zion Pemberton", role: "coo", actor: system });
    expect(second.staffId).toBe(first.staffId);
    expect(await findPendingInvite(first.token)).toBeNull();
    expect(await findPendingInvite(second.token)).not.toBeNull();
  });

  it("won't invite a State ID that already belongs to an active member", async () => {
    const { token } = await createInvite({ stateId: 3628, characterName: "Skyler Marlowe", role: "loan_officer", actor: system });
    await completeInvite({ invite: (await findPendingInvite(token))!, userId: await fakeUser("skyler") });
    await expect(
      createInvite({ stateId: 3628, characterName: "Imposter", role: "owner", actor: system }),
    ).rejects.toThrow(/already belongs/);
  });
});
