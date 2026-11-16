"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { runAction } from "@/server/action";
import { authorize } from "@/server/authz/viewer";
import {
  borrowerForOffer,
  cancelOffer,
  createOffer,
  issueOffer,
  linkOffer,
  unlinkOffer,
  updateOffer,
  type cancelOfferSchema,
  type linkOfferSchema,
  type offerSchema,
  type unlinkOfferSchema,
} from "@/server/origination/loan-offers";

export async function borrowerForOfferAction(stateId: number) {
  return runAction(async () => {
    const viewer = await authorize("loans.originate");
    const id = z.number().int().positive().max(9_999_999).parse(stateId);
    const b = await borrowerForOffer(viewer, id);
    return { name: b.name, record: b.record, flags: b.check.flags };
  });
}

export async function saveOfferAction(input: z.input<typeof offerSchema>, opts: { id?: string | null; issue?: boolean }) {
  return runAction(async () => {
    const viewer = await authorize("loans.originate");
    const id = opts.id ? z.uuid().parse(opts.id) : await createOffer(viewer, input);
    if (opts.id) await updateOffer(viewer, id, input);
    if (opts.issue) await issueOffer(viewer, id);
    revalidatePath("/loans/offers");
    return { id };
  });
}

export async function issueOfferAction(id: string) {
  return runAction(async () => {
    const viewer = await authorize("loans.originate");
    await issueOffer(viewer, z.uuid().parse(id));
    revalidatePath("/loans/offers");
  });
}

export async function cancelOfferAction(input: z.input<typeof cancelOfferSchema>) {
  return runAction(async () => {
    const viewer = await authorize("loans.originate");
    await cancelOffer(viewer, input);
    revalidatePath("/loans/offers");
  });
}

export async function unlinkOfferAction(input: z.input<typeof unlinkOfferSchema>) {
  return runAction(async () => {
    const viewer = await authorize("loans.originate");
    await unlinkOffer(viewer, input);
    revalidatePath("/loans/offers");
  });
}

export async function linkOfferAction(input: z.input<typeof linkOfferSchema>) {
  return runAction(async () => {
    const viewer = await authorize("loans.originate");
    await linkOffer(viewer, input);
    revalidatePath("/loans/offers");
  });
}
