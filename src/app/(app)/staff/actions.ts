"use server";

import { issuePasswordReset } from "@/server/staff/password-reset";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ROLES } from "@/lib/roles";
import { runAction } from "@/server/action";
import { authorize } from "@/server/authz/viewer";
import { changeName, changeRole, changeStatus, inviteStaff, reissueInvite, resetTwoFactor } from "@/server/staff/service";

const inviteSchema = z.object({
  stateId: z.coerce.number().int("State ID must be a whole number.").positive("State ID must be positive.").max(9_999_999),
  characterName: z.string().trim().min(2, "Enter the character's full name.").max(64),
  role: z.enum(ROLES),
});

export async function inviteStaffAction(input: z.input<typeof inviteSchema>) {
  return runAction(async () => {
    const viewer = await authorize("staff.manage");
    const result = await inviteStaff(viewer, inviteSchema.parse(input));
    revalidatePath("/staff");
    return { url: result.url, expiresAt: result.expiresAt.toISOString() };
  });
}

const idSchema = z.uuid();

export async function reissueInviteAction(staffId: string) {
  return runAction(async () => {
    const viewer = await authorize("staff.manage");
    const result = await reissueInvite(viewer, idSchema.parse(staffId));
    revalidatePath("/staff");
    return { url: result.url, expiresAt: result.expiresAt.toISOString() };
  });
}

export async function changeRoleAction(staffId: string, role: string) {
  return runAction(async () => {
    const viewer = await authorize("staff.manage");
    await changeRole(viewer, idSchema.parse(staffId), z.enum(ROLES).parse(role));
    revalidatePath("/staff");
  });
}

const nameSchema = z.object({
  staffId: z.uuid(),
  characterName: inviteSchema.shape.characterName,
});

export async function changeNameAction(input: z.input<typeof nameSchema>) {
  return runAction(async () => {
    const viewer = await authorize("staff.manage");
    const { staffId, characterName } = nameSchema.parse(input);
    await changeName(viewer, staffId, characterName);
    revalidatePath("/staff");
  });
}

const statusSchema = z.object({
  staffId: z.uuid(),
  change: z.enum(["suspend", "reactivate", "depart"]),
  reason: z.string().trim().min(5, "Give a short reason (at least 5 characters).").max(500),
});

export async function changeStatusAction(input: z.input<typeof statusSchema>) {
  return runAction(async () => {
    const viewer = await authorize("staff.manage");
    const { staffId, change, reason } = statusSchema.parse(input);
    await changeStatus(viewer, staffId, change, reason);
    revalidatePath("/staff");
  });
}

const resetSchema = z.object({ staffId: z.uuid(), reason: z.string().trim().min(5, "Give a short reason (at least 5 characters).").max(500) });

export async function issuePasswordResetAction(input: { staffId: string; reason: string }) {
  return runAction(async () => {
    const viewer = await authorize("staff.reset_password");
    const result = await issuePasswordReset(viewer, input);
    revalidatePath("/staff");
    return { url: result.url, expiresAt: result.expiresAt.toISOString() };
  });
}

export async function resetTwoFactorAction(input: z.input<typeof resetSchema>) {
  return runAction(async () => {
    const viewer = await authorize("staff.reset_2fa");
    const { staffId, reason } = resetSchema.parse(input);
    await resetTwoFactor(viewer, staffId, reason);
    revalidatePath("/staff");
  });
}
