import "server-only";
import { z } from "zod";
import { ForbiddenError } from "@/lib/permissions";
import { ImportError } from "@/server/bank/import";
import { LoanError } from "@/server/loans/errors";
import { InviteError } from "@/server/staff/invites";
import { friendlyIssue } from "@/lib/validation-messages";
import { recordAppError } from "@/server/app-errors";

export type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Wraps a Server Action body: known, user-safe errors become `{ ok: false }`;
 * anything unexpected is logged server-side and replaced with a generic message
 * so internals (SQL, stack traces) never reach the browser.
 */
export async function runAction<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof InviteError || error instanceof ImportError || error instanceof LoanError) {
      return { ok: false, error: error.message };
    }
    if (error instanceof z.ZodError) return { ok: false, error: error.issues[0] ? friendlyIssue(error.issues[0] as never) : "Something in the form isn't valid." };
    // Postgres can't store NUL or broken Unicode in text (Drizzle puts the PG error on `cause`).
    const code = (error as { cause?: { code?: string } })?.cause?.code;
    if (code === "22021" || code === "22P05") return { ok: false, error: "Some text contains a hidden control character that can't be saved. Retype it and try again." };
    console.error("[action] unexpected error", error);
    // Caught here, so Next never sees it: record it for the daily health check.
    await recordAppError({ source: "action-handled", error });
    return { ok: false, error: "Unexpected server error. Check whether the change saved before trying again." };
  }
}
