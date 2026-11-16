"use server";

import { revalidatePath } from "next/cache";
import { runAction } from "@/server/action";
import { authorize } from "@/server/authz/viewer";
import { addReading, adoptRule, voidReading, type addReadingSchema, type adoptRuleSchema, type voidReadingSchema } from "@/server/mortgages/allowance";
import type { z } from "zod";

export async function addReadingAction(input: z.input<typeof addReadingSchema>) {
  return runAction(async () => {
    const viewer = await authorize("allowance.record");
    await addReading(viewer, input);
    revalidatePath("/finance/allowance");
  });
}

export async function voidReadingAction(input: z.input<typeof voidReadingSchema>) {
  return runAction(async () => {
    const viewer = await authorize("allowance.record");
    await voidReading(viewer, input);
    revalidatePath("/finance/allowance");
  });
}

export async function adoptRuleAction(input: z.input<typeof adoptRuleSchema>) {
  return runAction(async () => {
    const viewer = await authorize("allowance.record");
    await adoptRule(viewer, input);
    revalidatePath("/finance/allowance");
  });
}
