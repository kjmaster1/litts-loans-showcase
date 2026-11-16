"use server";

import { runAction } from "@/server/action";
import { completeTour } from "@/server/account/tour";
import { authorize } from "@/server/authz/viewer";

/** The app tour was finished or skipped: don't offer it again (until a more senior role adds something). */
export async function completeTourAction() {
  return runAction(async () => {
    await completeTour(await authorize());
  });
}
