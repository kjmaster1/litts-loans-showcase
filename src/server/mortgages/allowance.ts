import "server-only";
import { asc, eq, isNotNull, isNull, and } from "drizzle-orm";
import { z } from "zod";
import {
  ALLOWANCE_RULES,
  expectedBalance,
  fitAllowance,
  ruleById,
  type AllowanceEvent,
  type AllowanceFit,
  type AllowanceReading,
  type AllowanceRule,
} from "@/domain/mortgages/allowance";
import { mortgageSchedule, type MortgagePayment } from "@/domain/mortgages/schedule";
import { can, ForbiddenError } from "@/lib/permissions";
import { recordAudit } from "@/server/audit/audit";
import type { Viewer } from "@/server/authz/viewer";
import { db } from "@/server/db";
import { allowanceReading, appSetting, mortgage, staff } from "@/server/db/schema";
import { LoanError } from "@/server/loans/errors";
import { getRequestMeta } from "@/server/request";
import { hasTerms } from "./queries";
import { getServerOutlook } from "./allowance-outlook";
import { paymentsByMortgage } from "./payments";

/** State allowance tracker (docs/design/MORTGAGES.md §State allowance). Management+. */

const RULE_KEY = "allowance.rule";

export const addReadingSchema = z.object({
  balanceDollars: z.number().int("The allowance is always whole dollars.").min(-1_000_000_000).max(1_000_000_000),
  observedAt: z.coerce.date(),
  note: z.string().trim().max(300).optional(),
});

export async function addReading(viewer: Viewer, raw: z.input<typeof addReadingSchema>): Promise<void> {
  if (!can(viewer.role, "allowance.record")) throw new ForbiddenError();
  const input = addReadingSchema.parse(raw);
  if (input.observedAt.getTime() > Date.now() + 5 * 60_000) throw new LoanError("That time is in the future.");
  if (input.observedAt < new Date("2025-01-01T00:00:00Z")) throw new LoanError("That time is too far in the past.");
  const request = await getRequestMeta();
  await db.transaction(async (tx) => {
    const [dupe] = await tx
      .select({ id: allowanceReading.id })
      .from(allowanceReading)
      .where(and(eq(allowanceReading.observedAt, input.observedAt), eq(allowanceReading.balanceCents, input.balanceDollars * 100), isNull(allowanceReading.voidedAt)));
    if (dupe) throw new LoanError("That reading is already recorded (same balance at the same time).");
    const [r] = await tx
      .insert(allowanceReading)
      .values({ observedAt: input.observedAt, balanceCents: input.balanceDollars * 100, note: input.note || null, createdByStaffId: viewer.staffId })
      .returning({ id: allowanceReading.id });
    await recordAudit(tx, {
      actor: { type: "staff", staffId: viewer.staffId },
      action: "allowance.reading.added",
      target: { type: "allowance_reading", id: r.id },
      metadata: { balanceCents: input.balanceDollars * 100, observedAt: input.observedAt.toISOString() },
      request,
    });
  });
}

export const voidReadingSchema = z.object({ id: z.uuid(), reason: z.string().trim().min(5, "Give a reason (at least 5 characters).").max(300) });

export async function voidReading(viewer: Viewer, raw: z.input<typeof voidReadingSchema>): Promise<void> {
  if (!can(viewer.role, "allowance.record")) throw new ForbiddenError();
  const input = voidReadingSchema.parse(raw);
  const request = await getRequestMeta();
  await db.transaction(async (tx) => {
    const updated = await tx
      .update(allowanceReading)
      .set({ voidedAt: new Date(), voidedByStaffId: viewer.staffId, voidReason: input.reason })
      .where(and(eq(allowanceReading.id, input.id), isNull(allowanceReading.voidedAt)))
      .returning({ id: allowanceReading.id, balanceCents: allowanceReading.balanceCents });
    if (updated.length === 0) throw new LoanError("That reading doesn't exist or is already voided.");
    await recordAudit(tx, {
      actor: { type: "staff", staffId: viewer.staffId },
      action: "allowance.reading.voided",
      target: { type: "allowance_reading", id: input.id },
      reason: input.reason,
      metadata: { balanceCents: updated[0].balanceCents },
      request,
    });
  });
}

export const adoptRuleSchema = z.object({ ruleId: z.string().nullable(), reason: z.string().trim().min(5, "Give a reason (at least 5 characters).").max(300) });

export async function adoptRule(viewer: Viewer, raw: z.input<typeof adoptRuleSchema>): Promise<void> {
  if (!can(viewer.role, "allowance.record")) throw new ForbiddenError();
  const input = adoptRuleSchema.parse(raw);
  if (input.ruleId !== null && !ruleById(input.ruleId)) throw new LoanError("Unknown rule.");
  const request = await getRequestMeta();
  await db.transaction(async (tx) => {
    const value = { ruleId: input.ruleId, adoptedAt: new Date().toISOString() };
    await tx
      .insert(appSetting)
      .values({ key: RULE_KEY, value, updatedByStaffId: viewer.staffId })
      .onConflictDoUpdate({ target: appSetting.key, set: { value, updatedByStaffId: viewer.staffId, updatedAt: new Date() } });
    await recordAudit(tx, {
      actor: { type: "staff", staffId: viewer.staffId },
      action: "allowance.rule.adopted",
      target: { type: "setting", id: RULE_KEY },
      reason: input.reason,
      metadata: { ruleId: input.ruleId },
      request,
    });
  });
}

export type AllowanceView = {
  readings: { id: string; observedAt: Date; balanceCents: number; note: string | null; by: string | null; voidedAt: Date | null; voidReason: string | null }[];
  events: AllowanceEvent[];
  fit: AllowanceFit;
  adopted: { rule: AllowanceRule; adoptedAt: string } | null;
  /** The adopted rule, else the best fit when it is conclusive. */
  projection: { rule: AllowanceRule; source: "adopted" | "best_fit"; balanceCents: number; fromReading: Date; eventsSince: number } | null;
  gaps: { mortgagesWithoutTerms: number; repaymentsWithoutPrincipal: number };
  rules: AllowanceRule[];
};

type Mortgage = typeof mortgage.$inferSelect;

export type AllowanceData = {
  readings: AllowanceView["readings"];
  /** Originations and repayments of State-funded mortgages, oldest first. */
  events: AllowanceEvent[];
  mortgages: Mortgage[];
  payments: Map<string, MortgagePayment[]>;
  fit: AllowanceFit;
  adopted: AllowanceView["adopted"];
  /** The adopted rule, else the best fit when it is conclusive. */
  rule: AllowanceRule | null;
  ruleSource: "adopted" | "best_fit" | "none";
  gaps: AllowanceView["gaps"];
};

/** Everything the allowance figures are built from (the Finance page, the outlook and the quote pages share it). */
export async function loadAllowanceData(): Promise<AllowanceData> {
  const by = staff;
  const [readingRows, mortgages, setting] = await Promise.all([
    db
      .select({
        id: allowanceReading.id,
        observedAt: allowanceReading.observedAt,
        balanceCents: allowanceReading.balanceCents,
        note: allowanceReading.note,
        by: by.characterName,
        voidedAt: allowanceReading.voidedAt,
        voidReason: allowanceReading.voidReason,
      })
      .from(allowanceReading)
      .leftJoin(by, eq(by.id, allowanceReading.createdByStaffId))
      .orderBy(asc(allowanceReading.observedAt)),
    // Company-funded mortgages don't use the State's money, so they're left out.
    db.select().from(mortgage).where(and(isNotNull(mortgage.originatedAt), isNull(mortgage.mergedIntoId), eq(mortgage.funding, "state"))),
    db.select().from(appSetting).where(eq(appSetting.key, RULE_KEY)),
  ]);

  const payments = await paymentsByMortgage(mortgages.map((m) => m.id));
  const events: AllowanceEvent[] = [];
  let withoutTerms = 0;
  let withoutPrincipal = 0;
  for (const m of mortgages) {
    if (m.loanCents === null) withoutTerms++;
    else events.push({ kind: "origination", at: m.originatedAt!, loanCents: m.loanCents, label: m.address });
    const schedule = hasTerms(m)
      ? mortgageSchedule({ loanCents: m.loanCents!, brokerInterestCents: m.brokerInterestCents!, federalInterestCents: m.federalInterestCents ?? 0, instalments: m.instalments!, originatedAt: m.originatedAt! })
      : null;
    (payments.get(m.id) ?? []).forEach((p, i) => {
      const principal = p.toStateCents ?? schedule?.[i]?.principalCents ?? null;
      if (principal === null) withoutPrincipal++;
      events.push({ kind: "repayment", at: p.occurredAt, grossCents: p.grossCents, principalCents: principal ?? 0, label: `${m.address} #${i + 1}` });
    });
  }
  events.sort((a, b) => a.at.getTime() - b.at.getTime());

  const live: AllowanceReading[] = readingRows.filter((r) => !r.voidedAt).map((r) => ({ id: r.id, at: r.observedAt, balanceCents: r.balanceCents }));
  const fit = fitAllowance(live, events);
  const stored = setting[0]?.value as { ruleId: string | null; adoptedAt: string } | undefined;
  const adoptedRule = ruleById(stored?.ruleId);
  const adopted = adoptedRule && stored ? { rule: adoptedRule, adoptedAt: stored.adoptedAt } : null;
  const rule = adopted ? adopted.rule : fit.conclusive ? fit.ranking[0].rule : null;
  const ruleSource = adopted ? ("adopted" as const) : fit.conclusive ? ("best_fit" as const) : ("none" as const);
  return { readings: readingRows, events, mortgages, payments, fit, adopted, rule, ruleSource, gaps: { mortgagesWithoutTerms: withoutTerms, repaymentsWithoutPrincipal: withoutPrincipal } };
}

export async function getAllowanceView(): Promise<AllowanceView> {
  const d = await loadAllowanceData();
  const live: AllowanceReading[] = d.readings.filter((r) => !r.voidedAt).map((r) => ({ id: r.id, at: r.observedAt, balanceCents: r.balanceCents }));
  const expected = d.rule ? expectedBalance(live, d.events, d.rule) : null;
  return {
    readings: d.readings,
    events: d.events,
    fit: d.fit,
    adopted: d.adopted,
    projection: d.rule && d.ruleSource !== "none" && expected ? { rule: d.rule, source: d.ruleSource, balanceCents: expected.balanceCents, fromReading: expected.from.at, eventsSince: expected.events.length } : null,
    gaps: d.gaps,
    rules: ALLOWANCE_RULES,
  };
}

export type AllowanceLeft = {
  balanceCents: number;
  /** "projected": the adopted (or conclusive best-fit) rule carried forward to now; "reading": the latest reading as typed. */
  source: "projected" | "reading";
  /** The reading it starts from. */
  readingAt: Date;
};

/**
 * How much State allowance is left, for officers quoting mortgages (owner, 2026-10-11): the
 * figure only — the readings and rules stay on the Finance page. It is the outlook's "now", so every
 * page shows the same figure (research/19 §2).
 */
export async function allowanceLeft(now: Date = new Date()): Promise<AllowanceLeft | null> {
  const outlook = await getServerOutlook(now);
  if (!outlook) return null;
  return { balanceCents: outlook.nowCents, source: outlook.ruleSource === "none" ? "reading" : "projected", readingAt: outlook.readingAt };
}
