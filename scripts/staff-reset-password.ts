/**
 * Issue a one-time password reset link from the command line — the break-glass path
 * for when nobody who outranks the person can sign in (e.g. the COO, while the Owner
 * hasn't set up their account). Like `staff:invite`, anyone able to run this already
 * has database credentials; it's still audited, as `system`, with the reason given.
 *
 *   pnpm staff:reset-password --state-id 20035 --reason "Forgot to save it at sign-up"
 */
import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db";
import { staff } from "@/server/db/schema";
import { createPasswordReset } from "@/server/staff/password-reset";

const { values } = parseArgs({ options: { "state-id": { type: "string" }, reason: { type: "string" } } });
const input = z
  .object({ stateId: z.coerce.number().int().positive(), reason: z.string().trim().min(5) })
  .safeParse({ stateId: values["state-id"], reason: values.reason });
if (!input.success) {
  console.error('Usage: pnpm staff:reset-password --state-id <id> --reason "<why, at least 5 characters>"');
  process.exit(1);
}

const [target] = await db.select().from(staff).where(eq(staff.stateId, input.data.stateId));
if (!target) {
  console.error(`No staff member with State ID ${input.data.stateId}.`);
  process.exit(1);
}
const { url, expiresAt } = await createPasswordReset({ target, reason: input.data.reason, actor: { type: "system" } });
console.log(`\nPassword reset for ${target.characterName} (#${target.stateId})`);
console.log(`  ${url}`);
console.log(`  Expires ${expiresAt.toISOString()} — single use. Share privately. They keep their authenticator.\n`);
process.exit(0);
