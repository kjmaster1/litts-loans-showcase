/**
 * Issue a staff invite from the command line. Needed to bootstrap the first
 * account, and as a break-glass path (e.g. if no executive can sign in).
 * Anyone able to run this already has database credentials, so it is not a
 * privilege escalation; it is still recorded in the audit log as `system`.
 *
 *   pnpm staff:invite --state-id 3454 --name "Kieran Jones" --role ceo
 */
import { parseArgs } from "node:util";
import { z } from "zod";
import { ROLES } from "@/lib/roles";
import { createInvite } from "@/server/staff/invites";
import { inviteUrl } from "@/server/staff/service";

const { values } = parseArgs({
  options: {
    "state-id": { type: "string" },
    name: { type: "string" },
    role: { type: "string" },
  },
});

const input = z
  .object({
    stateId: z.coerce.number().int().positive(),
    characterName: z.string().trim().min(2),
    role: z.enum(ROLES),
  })
  .safeParse({ stateId: values["state-id"], characterName: values.name, role: values.role });

if (!input.success) {
  console.error(`Usage: pnpm staff:invite --state-id <id> --name "<Character Name>" --role <${ROLES.join("|")}>`);
  console.error(input.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n"));
  process.exit(1);
}

const { token, expiresAt } = await createInvite({ ...input.data, actor: { type: "system" } });
console.log(`\nInvite for ${input.data.characterName} (${input.data.role}, #${input.data.stateId})`);
console.log(`  ${inviteUrl(token)}`);
console.log(`  Expires ${expiresAt.toISOString()} — single use. Share privately.\n`);
process.exit(0);
