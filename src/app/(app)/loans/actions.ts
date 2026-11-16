"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { runAction } from "@/server/action";
import { authorize } from "@/server/authz/viewer";
import { commitPaste, LOAN_TABS, previewPaste, type CommitPasteInput } from "@/server/loans/paste";
import { logCollection, type logCollectionSchema } from "@/server/loans/collections";
import { clearDoNotLend, setDoNotLend, type doNotLendSchema } from "@/server/loans/lending";
import { applyRelink, type applyRelinkSchema } from "@/server/loans/relink";
import {
  addCollateral,
  addLoanNote,
  assignOfficer,
  markRepaid,
  retireCardOnlyLoan,
  setCollateralStatus,
  writeOffLoan,
  type addCollateralSchema,
  type assignOfficerSchema,
  type collateralStatusSchema,
  type markRepaidSchema,
  type noteSchema,
  type retireCardOnlyLoanSchema,
  type writeOffSchema,
} from "@/server/loans/service";

const previewSchema = z.object({ tab: z.enum(LOAN_TABS), text: z.string().min(1, "Paste the tab's text first.").max(400_000) });

export async function previewPasteAction(input: z.input<typeof previewSchema>) {
  return runAction(async () => {
    const viewer = await authorize("imports.paste");
    return previewPaste(viewer, previewSchema.parse(input));
  });
}

export async function commitPasteAction(input: CommitPasteInput) {
  return runAction(async () => {
    const viewer = await authorize("imports.paste");
    const result = await commitPaste(viewer, input);
    revalidatePath("/loans", "layout");
    revalidatePath("/finance", "layout");
    return result;
  });
}

export async function writeOffAction(input: z.input<typeof writeOffSchema>) {
  return runAction(async () => {
    const viewer = await authorize("loans.charge_off");
    const result = await writeOffLoan(viewer, input);
    revalidatePath("/loans", "layout");
    revalidatePath("/finance", "layout");
    return result;
  });
}

export async function assignOfficerAction(input: z.input<typeof assignOfficerSchema>) {
  return runAction(async () => {
    const viewer = await authorize();
    await assignOfficer(viewer, input);
    revalidatePath("/loans", "layout");
  });
}

export async function addCollateralAction(input: z.input<typeof addCollateralSchema>) {
  return runAction(async () => {
    const viewer = await authorize();
    await addCollateral(viewer, input);
    revalidatePath("/loans", "layout");
  });
}

export async function setCollateralStatusAction(input: z.input<typeof collateralStatusSchema>) {
  return runAction(async () => {
    const viewer = await authorize();
    await setCollateralStatus(viewer, input);
    revalidatePath("/loans", "layout");
  });
}

export async function addNoteAction(input: z.input<typeof noteSchema>) {
  return runAction(async () => {
    const viewer = await authorize();
    await addLoanNote(viewer, input);
    revalidatePath("/loans", "layout");
  });
}

export async function relinkAction(input: z.input<typeof applyRelinkSchema>) {
  return runAction(async () => {
    const viewer = await authorize("loans.edit_metadata");
    const result = await applyRelink(viewer, input);
    revalidatePath("/loans", "layout");
    revalidatePath("/finance", "layout");
    return result;
  });
}

export async function markRepaidAction(input: z.input<typeof markRepaidSchema>) {
  return runAction(async () => {
    const viewer = await authorize("loans.edit_metadata");
    await markRepaid(viewer, input);
    revalidatePath("/loans", "layout");
    revalidatePath("/finance", "layout");
  });
}

export async function setDoNotLendAction(input: z.input<typeof doNotLendSchema>) {
  return runAction(async () => {
    const viewer = await authorize("loans.edit_metadata");
    await setDoNotLend(viewer, input);
    revalidatePath("/loans", "layout");
  });
}

export async function clearDoNotLendAction(input: z.input<typeof doNotLendSchema>) {
  return runAction(async () => {
    const viewer = await authorize("loans.edit_metadata");
    await clearDoNotLend(viewer, input);
    revalidatePath("/loans", "layout");
  });
}

export async function logCollectionAction(input: z.input<typeof logCollectionSchema>) {
  return runAction(async () => {
    // Any staff member; the service allows the loan's officer, Legal and management.
    const viewer = await authorize("borrower.lookup");
    await logCollection(viewer, input);
    revalidatePath("/loans", "layout");
    revalidatePath("/", "page");
  });
}

export async function retireCardOnlyLoanAction(input: z.input<typeof retireCardOnlyLoanSchema>) {
  return runAction(async () => {
    const viewer = await authorize("records.merge");
    const result = await retireCardOnlyLoan(viewer, input);
    revalidatePath("/loans", "layout");
    return result;
  });
}
