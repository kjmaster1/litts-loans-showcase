"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { revokeMyOtherSessions, revokeMySession } from "@/server/account/sessions";
import { runAction } from "@/server/action";
import { requireFreshStepUp } from "@/server/auth/step-up";
import { authorize } from "@/server/authz/viewer";

/** Answers STEP_UP_REQUIRED unless a fresh step-up is in place (before adding a passkey). */
export async function checkStepUpAction() {
  return runAction(async () => {
    const viewer = await authorize();
    requireFreshStepUp(viewer);
  });
}

export async function revokeSessionAction(sessionId: string) {
  return runAction(async () => {
    const viewer = await authorize();
    await revokeMySession(viewer, z.string().min(1).max(64).parse(sessionId));
    revalidatePath("/account/security");
  });
}

export async function revokeOtherSessionsAction() {
  return runAction(async () => {
    const viewer = await authorize();
    const count = await revokeMyOtherSessions(viewer);
    revalidatePath("/account/security");
    return count;
  });
}
