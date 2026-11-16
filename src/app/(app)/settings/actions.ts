"use server";

import { revalidatePath } from "next/cache";
import type { z } from "zod";
import { runAction } from "@/server/action";
import { authorize } from "@/server/authz/viewer";
import { requireFreshStepUp } from "@/server/auth/step-up-guard";
import { saveSettings, type saveSettingsSchema } from "@/server/settings";

export async function saveSettingsAction(input: z.input<typeof saveSettingsSchema>) {
  return runAction(async () => {
    const viewer = await authorize("settings.manage");
    const result = await saveSettings(viewer, input);
    // Rates and rules feed commissions, loans and mortgages.
    revalidatePath("/", "layout");
    return result;
  });
}

/** Confirms the viewer may download the full export with a fresh code; the download itself re-checks. */
export async function prepareExportAction() {
  return runAction(async () => {
    const viewer = await authorize("settings.manage");
    requireFreshStepUp(viewer);
  });
}
