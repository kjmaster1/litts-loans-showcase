"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { runAction } from "@/server/action";
import { authorize } from "@/server/authz/viewer";
import { commitImport, discardStaging, ImportError, stageImport } from "@/server/bank/import";

/** Step 1: upload + parse + classify → staged preview (nothing posted yet). */
export async function uploadExportAction(formData: FormData) {
  return runAction(async () => {
    const viewer = await authorize("bank.import");
    const file = formData.get("file");
    if (!(file instanceof File)) throw new ImportError("Choose the .xlsx file exported from the bank.");
    const stagingId = await stageImport(viewer, { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
    return { stagingId };
  });
}

/** Step 2: post the staged rows to the ledger in one transaction. */
export async function commitImportAction(stagingId: string) {
  return runAction(async () => {
    const viewer = await authorize("bank.import");
    const result = await commitImport(viewer, z.uuid().parse(stagingId));
    revalidatePath("/finance", "layout");
    return result;
  });
}

export async function discardImportAction(stagingId: string) {
  return runAction(async () => {
    const viewer = await authorize("bank.import");
    await discardStaging(viewer, z.uuid().parse(stagingId));
  });
}
