"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { runAction } from "@/server/action";
import { authorize } from "@/server/authz/viewer";
import { applyOfficerSuggestions, linkWallet, type applySuggestionsSchema, type linkWalletSchema } from "@/server/commissions/officers";
import { assignPayout, closeWeek, saveRoster, type assignPayoutSchema, type rosterSchema } from "@/server/commissions/service";

export async function saveRosterAction(input: z.input<typeof rosterSchema>) {
  return runAction(async () => {
    const viewer = await authorize("commissions.manage");
    await saveRoster(viewer, input);
    revalidatePath("/commissions", "layout");
  });
}

export async function closeWeekAction(weekKey: string) {
  return runAction(async () => {
    const viewer = await authorize("commissions.manage");
    const result = await closeWeek(viewer, z.string().max(10).parse(weekKey));
    revalidatePath("/commissions", "layout");
    revalidatePath("/finance", "layout");
    return result;
  });
}

export async function assignPayoutAction(input: z.input<typeof assignPayoutSchema>) {
  return runAction(async () => {
    const viewer = await authorize("commissions.manage");
    await assignPayout(viewer, input);
    revalidatePath("/commissions", "layout");
    revalidatePath("/finance", "layout");
  });
}

export async function linkWalletAction(input: z.input<typeof linkWalletSchema>) {
  return runAction(async () => {
    const viewer = await authorize("commissions.manage");
    const result = await linkWallet(viewer, input);
    revalidatePath("/commissions", "layout");
    revalidatePath("/finance", "layout");
    return result;
  });
}

export async function applyOfficerSuggestionsAction(input: z.input<typeof applySuggestionsSchema>) {
  return runAction(async () => {
    const viewer = await authorize("loans.reassign_officer");
    const result = await applyOfficerSuggestions(viewer, input);
    revalidatePath("/commissions", "layout");
    revalidatePath("/loans", "layout");
    return result;
  });
}
