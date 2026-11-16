"use server";

import { revalidatePath } from "next/cache";
import type { z } from "zod";
import { runAction } from "@/server/action";
import { authorize } from "@/server/authz/viewer";
import { closeLegacyClearing, type closeLegacySchema } from "@/server/ledger/legacy";
import { closeStaffLoans, type closeStaffLoansSchema } from "@/server/ledger/staff-loans";

export async function closeLegacyAction(input: z.input<typeof closeLegacySchema>) {
  return runAction(async () => {
    const viewer = await authorize("ledger.adjust");
    const result = await closeLegacyClearing(viewer, input);
    revalidatePath("/finance", "layout");
    return result;
  });
}

export async function closeStaffLoansAction(input: z.input<typeof closeStaffLoansSchema>) {
  return runAction(async () => {
    const viewer = await authorize("ledger.adjust");
    const result = await closeStaffLoans(viewer, input);
    revalidatePath("/finance", "layout");
    return result;
  });
}
