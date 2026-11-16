"use server";

import { z } from "zod";
import { runAction } from "@/server/action";
import { verifyStepUp } from "@/server/auth/step-up";
import { authorize } from "@/server/authz/viewer";

/** Confirms a fresh authenticator code, unlocking sensitive actions for a few minutes. */
export async function stepUpAction(code: string) {
  return runAction(async () => {
    const viewer = await authorize();
    const { until } = await verifyStepUp(viewer, z.string().max(10).parse(code));
    return { until: until.toISOString() };
  });
}
