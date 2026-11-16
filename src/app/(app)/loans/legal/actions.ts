"use server";

import { revalidatePath } from "next/cache";
import type { z } from "zod";
import { runAction } from "@/server/action";
import { authorize } from "@/server/authz/viewer";
import {
  closeCase,
  type closeCaseSchema,
  confirmFeePayment,
  type confirmFeeSchema,
  type contractSharedSchema,
  type contractNoteSchema,
  type caseDefaultDateSchema,
  handToLegal,
  type handToLegalSchema,
  type legalTermsSchema,
  markContractShared,
  requestDetails,
  setCaseDefaultDate,
  setContractNote,
  setLegalTerms,
  unlinkFeePayment,
  type unlinkFeeSchema,
} from "@/server/legal/cases";

/** Legal cases (2026-11-10). Record-level rules are checked in `server/legal/cases.ts`. */

const done = () => revalidatePath("/loans", "layout");

export async function setLegalTermsAction(input: z.input<typeof legalTermsSchema>) {
  return runAction(async () => {
    await setLegalTerms(await authorize(), input);
    done();
  });
}

export async function requestDetailsAction(loanId: string) {
  return runAction(async () => {
    await requestDetails(await authorize(), { loanId });
    done();
  });
}

export async function markContractSharedAction(input: z.input<typeof contractSharedSchema>) {
  return runAction(async () => {
    await markContractShared(await authorize(), input);
    done();
  });
}

export async function setCaseDefaultDateAction(input: z.input<typeof caseDefaultDateSchema>) {
  return runAction(async () => {
    await setCaseDefaultDate(await authorize(), input);
    done();
  });
}

export async function setContractNoteAction(input: z.input<typeof contractNoteSchema>) {
  return runAction(async () => {
    await setContractNote(await authorize(), input);
    done();
  });
}

export async function handToLegalAction(input: z.input<typeof handToLegalSchema>) {
  return runAction(async () => {
    await handToLegal(await authorize(), input);
    done();
  });
}

export async function closeCaseAction(input: z.input<typeof closeCaseSchema>) {
  return runAction(async () => {
    await closeCase(await authorize(), input);
    done();
  });
}

export async function confirmFeePaymentAction(input: z.input<typeof confirmFeeSchema>) {
  return runAction(async () => {
    await confirmFeePayment(await authorize(), input);
    done();
  });
}

export async function unlinkFeePaymentAction(input: z.input<typeof unlinkFeeSchema>) {
  return runAction(async () => {
    await unlinkFeePayment(await authorize(), input);
    done();
  });
}
