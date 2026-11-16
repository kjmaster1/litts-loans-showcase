"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { runAction } from "@/server/action";
import { authorize } from "@/server/authz/viewer";
import {
  addQuoteNote,
  approveQuote,
  resolveQuoteNote,
  type addQuoteNoteSchema,
  type approveQuoteSchema,
  type resolveQuoteNoteSchema,
} from "@/server/origination/quote-review";
import { previewConfirmView } from "@/server/mortgages/allowance-outlook";
import {
  cancelQuote,
  confirmQuote,
  linkQuote,
  markQuoteSigned,
  saveQuoteDetailed,
  unconfirmQuote,
  unlinkQuote,
  type cancelQuoteSchema,
  type confirmQuoteSchema,
  type linkQuoteSchema,
  type markSignedSchema,
  type quoteSchema,
  type unconfirmQuoteSchema,
  type unlinkQuoteSchema,
} from "@/server/origination/mortgage-quotes";

export async function saveQuoteAction(input: z.input<typeof quoteSchema>, id?: string | null) {
  return runAction(async () => {
    const viewer = await authorize("loans.originate");
    const saved = await saveQuoteDetailed(viewer, input, id ? z.uuid().parse(id) : undefined);
    revalidatePath("/mortgages/quotes");
    return saved;
  });
}

export async function cancelQuoteAction(input: z.input<typeof cancelQuoteSchema>) {
  return runAction(async () => {
    const viewer = await authorize("loans.originate");
    await cancelQuote(viewer, input);
    revalidatePath("/mortgages/quotes");
  });
}

export async function unlinkQuoteAction(input: z.input<typeof unlinkQuoteSchema>) {
  return runAction(async () => {
    const viewer = await authorize("loans.originate");
    await unlinkQuote(viewer, input);
    revalidatePath("/mortgages/quotes");
  });
}

export async function linkQuoteAction(input: z.input<typeof linkQuoteSchema>) {
  return runAction(async () => {
    const viewer = await authorize("loans.originate");
    await linkQuote(viewer, input);
    revalidatePath("/mortgages/quotes");
  });
}

export async function addQuoteNoteAction(input: z.input<typeof addQuoteNoteSchema>) {
  return runAction(async () => {
    const viewer = await authorize("loans.reassign_officer");
    await addQuoteNote(viewer, input);
    revalidatePath("/mortgages/quotes", "layout");
  });
}

export async function resolveQuoteNoteAction(input: z.input<typeof resolveQuoteNoteSchema>) {
  return runAction(async () => {
    const viewer = await authorize("loans.originate");
    await resolveQuoteNote(viewer, input);
    revalidatePath("/mortgages/quotes", "layout");
  });
}

export async function approveQuoteAction(input: z.input<typeof approveQuoteSchema>) {
  return runAction(async () => {
    const viewer = await authorize("mortgages.approve_large");
    await approveQuote(viewer, input);
    revalidatePath("/mortgages/quotes", "layout");
  });
}

export async function confirmQuoteAction(input: z.input<typeof confirmQuoteSchema>) {
  return runAction(async () => {
    const viewer = await authorize("loans.originate");
    await confirmQuote(viewer, input);
    revalidatePath("/mortgages/quotes", "layout");
  });
}

export async function unconfirmQuoteAction(input: z.input<typeof unconfirmQuoteSchema>) {
  return runAction(async () => {
    const viewer = await authorize("loans.originate");
    await unconfirmQuote(viewer, input);
    revalidatePath("/mortgages/quotes", "layout");
  });
}

export async function markQuoteSignedAction(input: z.input<typeof markSignedSchema>) {
  return runAction(async () => {
    const viewer = await authorize("loans.originate");
    await markQuoteSigned(viewer, input);
    revalidatePath("/mortgages/quotes", "layout");
  });
}

const previewSchema = z.object({ id: z.uuid(), expectedSigningAt: z.coerce.date() });

/** The Confirm dialog's working at the chosen time. Reads only, so nothing is revalidated (that would refresh the page under the dialog). */
export async function previewConfirmAction(input: { id: string; expectedSigningAt: string }) {
  return runAction(async () => {
    const viewer = await authorize("loans.originate");
    const { id, expectedSigningAt } = previewSchema.parse(input);
    return previewConfirmView(viewer, id, expectedSigningAt);
  });
}
