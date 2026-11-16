import "server-only";
import { asc, eq, inArray } from "drizzle-orm";
import {
  confirmedWorking,
  previewConfirmation,
  projectOutlook,
  type AllowanceOutlook,
  type ConfirmPreview,
  type ConfirmView,
  type OutlookInput,
  type OutlookInstalment,
  type OutlookMortgage,
  type OutlookQuote,
} from "@/domain/mortgages/allowance-outlook";
import { mortgageSchedule } from "@/domain/mortgages/schedule";
import { quoteMortgage } from "@/domain/origination/mortgage-quote";
import { LIVE_QUOTE_STATUSES } from "@/domain/origination/quote-status";
import { can, ForbiddenError } from "@/lib/permissions";
import { canSeeMortgage } from "@/server/authz/rules";
import type { Viewer } from "@/server/authz/viewer";
import { db } from "@/server/db";
import { mortgageQuote, staff } from "@/server/db/schema";
import { dataFreshness } from "@/server/freshness";
import { inputOf } from "@/server/origination/mortgage-quotes";
import { getSettings } from "@/server/settings";
import { loadAllowanceData } from "./allowance";
import { hasTerms } from "./queries";

/**
 * The allowance outlook's inputs, read from the database (docs/research/19 §2). One "now" is passed in, so a page
 * and everything on it agree. Mortgage addresses are labelled only for those who may see the mortgage
 * (`canSeeMortgage`): an officer sees the shape of the line, not other officers' clients.
 */

const toInstalments = (s: ReturnType<typeof mortgageSchedule>): OutlookInstalment[] => s.map((i) => ({ principalCents: i.principalCents, totalCents: i.totalCents }));

/** `canSee` decides which mortgages are labelled; the rest get a null label. */
async function buildOutlookInput(now: Date, canSee: (m: { officerStaffId: string | null }) => boolean): Promise<{ input: OutlookInput; ruleSource: AllowanceOutlook["ruleSource"] } | null> {
  const data = await loadAllowanceData();
  const reading = data.readings.filter((r) => !r.voidedAt).at(-1);
  if (!reading) return null;
  // Sequential: the freshness query, settings and quotes share the connection pool politely.
  const bankTo = (await dataFreshness()).bankTo;
  const settings = await getSettings();
  const quoteRows = await db.select().from(mortgageQuote).where(inArray(mortgageQuote.status, [...LIVE_QUOTE_STATUSES])).orderBy(asc(mortgageQuote.number));

  const mortgages: OutlookMortgage[] = data.mortgages
    .filter((m) => hasTerms(m) && m.originatedAt !== null)
    .sort((a, b) => a.originatedAt!.getTime() - b.originatedAt!.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((m) => ({
      id: m.id,
      label: canSee(m) ? m.address : null,
      status: m.status,
      originatedAt: m.originatedAt!,
      instalments: toInstalments(
        mortgageSchedule({ loanCents: m.loanCents!, brokerInterestCents: m.brokerInterestCents!, federalInterestCents: m.federalInterestCents ?? 0, instalments: m.instalments!, originatedAt: m.originatedAt! }),
      ),
      paidAt: (data.payments.get(m.id) ?? []).map((p) => p.occurredAt),
    }));

  const quotes: OutlookQuote[] = quoteRows.flatMap((q) => {
    if (q.status !== "draft" && q.status !== "confirmed") return [];
    const figures = quoteMortgage(inputOf(q));
    const schedule = mortgageSchedule({ loanCents: figures.loanCents, brokerInterestCents: figures.brokerInterestCents, federalInterestCents: figures.federalInterestCents, instalments: figures.instalments, originatedAt: new Date(0) });
    return [
      {
        id: q.id,
        number: q.number,
        address: q.address,
        officerStaffId: q.officerStaffId,
        status: q.status,
        companyFunded: q.companyFunded,
        loanCents: figures.loanCents,
        instalments: toInstalments(schedule),
        expectedSigningAt: q.expectedSigningAt,
        confirmedAt: q.confirmedAt,
        signedAt: q.signedAt,
      },
    ];
  });

  return {
    input: {
      now,
      reading: { at: reading.observedAt, balanceCents: reading.balanceCents },
      bankTo,
      rule: data.rule,
      knownEvents: data.events,
      mortgages,
      quotes,
      cushionCents: settings.mortgages.allowanceCushionDollars * 100,
    },
    ruleSource: data.ruleSource,
  };
}

/** Everyone who quotes sees the whole team's quotes; mortgages are labelled only when the viewer may see them. */
export async function getAllowanceOutlook(viewer: Viewer, now: Date = new Date()): Promise<AllowanceOutlook | null> {
  if (!can(viewer.role, "loans.originate")) throw new ForbiddenError();
  const built = await buildOutlookInput(now, (m) => canSeeMortgage(viewer, m));
  return built ? projectOutlook(built.input, built.ruleSource) : null;
}

/** The working behind confirming `quoteId` at `signingAt`; null when there is no reading or the quote isn't live. */
export async function previewConfirm(viewer: Viewer, quoteId: string, signingAt: Date, now: Date = new Date()): Promise<ConfirmPreview | null> {
  if (!can(viewer.role, "loans.originate")) throw new ForbiddenError();
  const built = await buildOutlookInput(now, (m) => canSeeMortgage(viewer, m));
  if (!built || !built.input.quotes.some((q) => q.id === quoteId)) return null;
  return previewConfirmation(built.input, quoteId, signingAt);
}

/** The outlook with every label shown, for server-side figures that are never listed (`allowanceLeft`). */
export async function getServerOutlook(now: Date): Promise<AllowanceOutlook | null> {
  const built = await buildOutlookInput(now, () => true);
  return built ? projectOutlook(built.input, built.ruleSource) : null;
}

/** Names the confirmed quotes a confirmation would push short (address, signing time, officer): no mortgage data. */
async function toView(viewer: Viewer, p: ConfirmPreview, rule: ConfirmView["rule"]): Promise<ConfirmView> {
  const ids = p.knockOn.map((k) => k.quoteId);
  const rows = ids.length
    ? await db
        .select({ id: mortgageQuote.id, address: mortgageQuote.address, expectedSigningAt: mortgageQuote.expectedSigningAt, officerName: staff.characterName })
        .from(mortgageQuote)
        .leftJoin(staff, eq(staff.id, mortgageQuote.officerStaffId))
        .where(inArray(mortgageQuote.id, ids))
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const cushionCents = (await getSettings()).mortgages.allowanceCushionDollars * 100;
  return {
    rule,
    cushionCents,
    nowCents: p.nowCents,
    repayments: p.repayments,
    signings: p.signings,
    quote: p.quote,
    knockOn: p.knockOn.map((k) => ({
      number: k.number,
      address: byId.get(k.quoteId)?.address ?? `Quote #${k.number}`,
      signingAt: byId.get(k.quoteId)?.expectedSigningAt ?? null,
      officerName: byId.get(k.quoteId)?.officerName ?? null,
      yours: k.officerStaffId === viewer.staffId,
      shortByCents: k.shortByCents,
    })),
  };
}

/** The Confirm dialog's working for `quoteId` signing at `signingAt`; null without a reading or for a quote that isn't live. */
export async function previewConfirmView(viewer: Viewer, quoteId: string, signingAt: Date, now: Date = new Date()): Promise<ConfirmView | null> {
  if (!can(viewer.role, "loans.originate")) throw new ForbiddenError();
  const built = await buildOutlookInput(now, (m) => canSeeMortgage(viewer, m));
  if (!built || !built.input.quotes.some((q) => q.id === quoteId)) return null;
  const rule = built.input.rule;
  return toView(viewer, previewConfirmation(built.input, quoteId, signingAt), { label: rule?.label ?? "", source: rule ? built.ruleSource : "none" });
}

/**
 * The quote page's "Allowance on signing day": a draft's what-if at its signing time (with what it would push short),
 * or a confirmed quote's figures from the outlook. Null without a reading, or for a quote with nothing to show.
 */
export async function quoteAllowance(
  viewer: Viewer,
  q: { id: string; status: string; expectedSigningAt: Date | null },
  now: Date = new Date(),
): Promise<ConfirmView | null> {
  if (!q.expectedSigningAt) return null;
  if (q.status === "draft") return previewConfirmView(viewer, q.id, q.expectedSigningAt, now);
  if (q.status !== "confirmed") return null;
  const outlook = await getAllowanceOutlook(viewer, now);
  const working = outlook ? confirmedWorking(outlook, q.id) : null;
  return outlook && working ? toView(viewer, working, { label: outlook.rule.label, source: outlook.ruleSource }) : null;
}
