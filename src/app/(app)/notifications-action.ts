"use server";

import { runAction } from "@/server/action";
import { authorize } from "@/server/authz/viewer";
import { markNotificationsRead, notificationsFor, type markReadSchema, type Notification } from "@/server/notifications";
import type { z } from "zod";

/** The bell's list, fetched fresh when it's opened. */
export async function notificationsAction() {
  return runAction(async (): Promise<Notification[]> => notificationsFor(await authorize("borrower.lookup")));
}

export async function markNotificationsReadAction(input: z.input<typeof markReadSchema>) {
  return runAction(async () => {
    await markNotificationsRead(await authorize("borrower.lookup"), input);
  });
}
