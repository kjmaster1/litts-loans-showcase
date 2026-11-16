"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { runAction } from "@/server/action";
import { authorize } from "@/server/authz/viewer";
import {
  addMortgageNote,
  assignMortgageOfficer,
  mergeMortgage,
  type assignMortgageOfficerSchema,
  type mergeMortgageSchema,
  type mortgageNoteSchema,
} from "@/server/mortgages/service";
import { approveMortgageAfter, type approveMortgageSchema } from "@/server/mortgages/approval";
import { commitTablet, MAX_TABLET_CHARS, previewTablet, type commitTabletSchema } from "@/server/mortgages/tablet";

const textSchema = z.object({ text: z.string().min(1, "Paste the agreement first.").max(MAX_TABLET_CHARS, "That paste is too long.") });

export async function previewTabletAction(input: z.input<typeof textSchema>) {
  return runAction(async () => {
    const viewer = await authorize("imports.paste");
    return previewTablet(viewer, textSchema.parse(input));
  });
}

export async function commitTabletAction(input: z.input<typeof commitTabletSchema>) {
  return runAction(async () => {
    const viewer = await authorize("imports.paste");
    const result = await commitTablet(viewer, input);
    revalidatePath("/mortgages", "layout");
    revalidatePath("/finance", "layout");
    return result;
  });
}

export async function assignMortgageOfficerAction(input: z.input<typeof assignMortgageOfficerSchema>) {
  return runAction(async () => {
    const viewer = await authorize();
    await assignMortgageOfficer(viewer, input);
    revalidatePath("/mortgages", "layout");
  });
}

export async function addMortgageNoteAction(input: z.input<typeof mortgageNoteSchema>) {
  return runAction(async () => {
    const viewer = await authorize();
    await addMortgageNote(viewer, input);
    revalidatePath("/mortgages", "layout");
  });
}

export async function mergeMortgageAction(input: z.input<typeof mergeMortgageSchema>) {
  return runAction(async () => {
    const viewer = await authorize("records.merge");
    await mergeMortgage(viewer, input);
    revalidatePath("/mortgages", "layout");
    revalidatePath("/finance", "layout");
  });
}

export async function approveMortgageAction(input: z.input<typeof approveMortgageSchema>) {
  return runAction(async () => {
    const viewer = await authorize("mortgages.approve_large");
    await approveMortgageAfter(viewer, input);
    revalidatePath("/mortgages", "layout");
  });
}
