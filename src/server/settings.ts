import "server-only";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { DEFAULT_SETTINGS, resolveSettings, settingsChanges, settingsSchema, type Settings } from "@/domain/settings";
import { can, ForbiddenError } from "@/lib/permissions";
import { recordAudit } from "@/server/audit/audit";
import { requireFreshStepUp } from "@/server/auth/step-up-guard";
import type { Viewer } from "@/server/authz/viewer";
import { db, type Tx } from "@/server/db";
import { companySetting, staff } from "@/server/db/schema";
import { LoanError } from "@/server/loans/errors";
import { getRequestMeta } from "@/server/request";

/** Company settings (research/11): versioned, newest applies. */

type Executor = typeof db | Tx;

export async function getSettings(executor: Executor = db): Promise<Settings> {
  const [row] = await executor.select({ values: companySetting.values }).from(companySetting).orderBy(desc(companySetting.createdAt)).limit(1);
  return row ? resolveSettings(row.values) : DEFAULT_SETTINGS;
}

export type SettingsVersion = { id: string; at: Date; by: string; reason: string; changes: { path: string; from: number; to: number }[] };

/** Every saved version, newest first, with what changed from the one before. */
export async function settingsHistory(): Promise<SettingsVersion[]> {
  const rows = await db
    .select({ id: companySetting.id, at: companySetting.createdAt, values: companySetting.values, reason: companySetting.reason, by: staff.characterName })
    .from(companySetting)
    .innerJoin(staff, eq(staff.id, companySetting.createdByStaffId))
    .orderBy(companySetting.createdAt);
  let previous = DEFAULT_SETTINGS;
  const out: SettingsVersion[] = [];
  for (const r of rows) {
    const current = resolveSettings(r.values);
    out.push({ id: r.id, at: r.at, by: r.by, reason: r.reason, changes: settingsChanges(previous, current) });
    previous = current;
  }
  return out.reverse();
}

export const saveSettingsSchema = z.object({ values: settingsSchema, reason: z.string().trim().min(5, "Give a reason (at least 5 characters).").max(500) });

/** Owner/CEO/COO, with a fresh authenticator code. Applies from now; closed weeks keep their rates. */
export async function saveSettings(viewer: Viewer, raw: z.input<typeof saveSettingsSchema>): Promise<{ changes: number }> {
  if (!can(viewer.role, "settings.manage")) throw new ForbiddenError();
  requireFreshStepUp(viewer);
  const input = saveSettingsSchema.parse(raw);
  const request = await getRequestMeta();
  return db.transaction(async (tx) => {
    const before = await getSettings(tx);
    const changes = settingsChanges(before, input.values);
    if (changes.length === 0) throw new LoanError("Nothing has changed.");
    const [row] = await tx.insert(companySetting).values({ values: input.values, reason: input.reason, createdByStaffId: viewer.staffId }).returning({ id: companySetting.id });
    await recordAudit(tx, {
      actor: { type: "staff", staffId: viewer.staffId },
      action: "settings.changed",
      target: { type: "company_setting", id: row.id },
      reason: input.reason,
      metadata: { changes },
      request,
    });
    return { changes: changes.length };
  });
}
