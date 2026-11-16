"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { runAction } from "@/server/action";
import { authorize } from "@/server/authz/viewer";
import { reclassifyTransaction } from "@/server/bank/reclassify";

const schema = z.object({
  transactionId: z.uuid(),
  category: z.string().min(1).max(64),
  reason: z.string().trim().min(5, "Give a short reason (at least 5 characters).").max(500),
});

export async function reclassifyAction(input: z.input<typeof schema>) {
  return runAction(async () => {
    const viewer = await authorize("bank.reclassify");
    const data = schema.parse(input);
    await reclassifyTransaction(viewer, data);
    revalidatePath("/finance", "layout");
  });
}
