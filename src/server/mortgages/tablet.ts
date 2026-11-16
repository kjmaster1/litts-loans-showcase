import "server-only";
import { randomUUID } from "node:crypto";
import { eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { parseTablet, type TabletMortgage } from "@/domain/mortgages/parse-tablet";
import { duplicateCandidates, fundingOf, hasAddress, originationFits, problemsForNewMortgage, withAlias } from "@/domain/mortgages/identity";
import { mortgageGuidelines, type GuidelineFlag } from "@/domain/mortgages/schedule";
import { recordAudit } from "@/server/audit/audit";
import type { Viewer } from "@/server/authz/viewer";
import { db, type Tx } from "@/server/db";
import { mortgage, mortgageEvent, mortgagePaste, mortgageSnapshot, staff } from "@/server/db/schema";
import { LoanError } from "@/server/loans/errors";
import { getRequestMeta } from "@/server/request";
import { previewApprovalFlag } from "./approval";
import { originationAmounts, syncMortgages } from "./sync";
import { getSettings } from "@/server/settings";

/**
 * Tablet "Sale Agreement – Financed" paste: preview → commit (stateless, like
 * the loan card paste). The tablet is the authority for a mortgage's terms and
 * parties; the bank rows remain the authority for money.
 */

export const MAX_TABLET_CHARS = 200_000;

type MortgageRow = typeof mortgage.$inferSelect;

/** An existing mortgage a would-be new agreement may duplicate (same buyer, same money). */
export type DuplicateCandidate = { id: string; address: string; priceCents: number | null; loanCents: number | null; originatedAt: string | null; pasted: boolean };

export type TabletPreviewItem = {
  index: number;
  address: string;
  addressRecognised: boolean;
  /** Lines above the address that were left out (the tablet's heading and tabs). */
  skippedLines: string[];
  buyer: { stateId: number | null; name: string } | null;
  officer: { stateId: number | null; name: string; staffId: string | null; staffName: string | null } | null;
  priceCents: number | null;
  loanCents: number | null;
  downPaymentCents: number | null;
  instalments: number | null;
  weeklyCents: number | null;
  brokerRateBp: number | null;
  fedRateBp: number | null;
  brokerFeeCents: number | null;
  paidCount: number | null;
  funding: "state" | "company";
  warnings: string[];
  guidelines: GuidelineFlag[];
  match:
    | { kind: "matched"; mortgageId: string; how: string; originatedAt: string | null; firstPaste: boolean; changes: string[] }
    | { kind: "new" }
    /** The buyer already has a mortgage this may be: staff must choose (or skip). */
    | { kind: "possible_duplicate"; candidates: DuplicateCandidate[]; newAllowed: boolean; problems: string[] }
    /** Not enough to start a new mortgage record; never saved. */
    | { kind: "refused"; problems: string[] }
    | { kind: "ignored"; reason: string };
};

export type TabletPreview = { items: TabletPreviewItem[]; ignoredLines: string[] };

const FIELDS: [keyof TabletMortgage, keyof MortgageRow, string][] = [
  ["priceCents", "priceCents", "price"],
  ["downPaymentCents", "downPaymentCents", "down payment"],
  ["loanCents", "loanCents", "loan amount"],
  ["brokerInterestCents", "brokerInterestCents", "interest"],
  ["federalInterestCents", "federalInterestCents", "federal interest"],
  ["instalments", "instalments", "payments"],
  ["termMonths", "termMonths", "term"],
  ["fedRateBp", "fedRateBp", "fed rate"],
  ["brokerRateBp", "brokerRateBp", "broker rate"],
  ["lateFeeCents", "lateFeeCents", "late fee"],
  ["gracePeriodDays", "gracePeriodDays", "grace period"],
  ["brokerFeeCents", "brokerFeeCents", "broker fee"],
  ["agencyCommissionCents", "agencyCommissionCents", "agency commission"],
];

function parseOrThrow(text: string) {
  if (text.length > MAX_TABLET_CHARS) throw new LoanError("That paste is too long.");
  const parsed = parseTablet(text);
  if (parsed.mortgages.length === 0) {
    throw new LoanError("No sale agreement found. Open the agreement on the tablet, copy everything from the address down to “After Tax”, and paste it here.");
  }
  return parsed;
}

type Origination = { mortgageId: string; netInCents: number; outCents: number | null };

async function context(executor: typeof db | Tx) {
  const mortgages = await executor.select().from(mortgage).where(isNull(mortgage.mergedIntoId));
  const amounts = await originationAmounts(executor, mortgages.flatMap((m) => (m.originationTxId ? [m.originationTxId] : [])));
  const origination = new Map<string, Origination>();
  for (const m of mortgages) {
    const o = m.originationTxId ? amounts.get(m.originationTxId) : undefined;
    if (o) origination.set(m.id, { mortgageId: m.id, ...o });
  }
  const officerIds = await executor.select({ id: staff.id, stateId: staff.stateId, name: staff.characterName }).from(staff);
  const guidelines = (await getSettings(executor)).mortgages;
  return { mortgages, origination, staffByStateId: new Map(officerIds.map((s) => [s.stateId, s])), guidelines };
}

type Ctx = Awaited<ReturnType<typeof context>>;
type Matched = Extract<TabletPreviewItem["match"], { kind: "matched" }> & { row: MortgageRow };

function matchedTo(t: TabletMortgage, row: MortgageRow, how: string): Matched {
  const changes = FIELDS.filter(([tk, mk]) => row[mk] !== null && t[tk] !== null && row[mk] !== t[tk]).map(([, , label]) => label);
  if (t.addressRecognised && !hasAddress(row, t.address)) changes.unshift(`address (was ${row.address})`);
  return { kind: "matched", mortgageId: row.id, how, originatedAt: row.originatedAt?.toISOString() ?? null, firstPaste: row.lastTabletAt === null, changes, row };
}

/**
 * The mortgage this agreement belongs to: same (current or former) address; if
 * several, the one whose money and buyer fit. If no address matches, the server
 * may have renumbered the house — then the same buyer's not-yet-pasted mortgage
 * whose down payment matches to the dollar. Otherwise it would be a new record:
 * refused if the paste is incomplete, and held for a person's decision if the
 * buyer already has a mortgage it may duplicate.
 */
function match(t: TabletMortgage, ctx: Ctx): Matched | Exclude<TabletPreviewItem["match"], { kind: "matched" }> {
  if (t.financeCompany && !/litt/i.test(t.financeCompany)) return { kind: "ignored", reason: `Financed by ${t.financeCompany}` };
  const fits = (m: MortgageRow) => {
    const o = ctx.origination.get(m.id);
    return !!o && originationFits(t, o);
  };

  // Only a real address may match by address (a stray heading once matched the record it had created), and not
  // another buyer's: the server hands old house numbers to other houses (115 North Rockford Dr, 2026-10-28).
  const buyer = t.buyer?.stateId ?? null;
  const otherBuyer = (m: MortgageRow) => buyer !== null && m.buyerStateId !== null && m.buyerStateId !== buyer;
  const same = t.addressRecognised ? ctx.mortgages.filter((m) => hasAddress(m, t.address) && !otherBuyer(m)) : [];
  if (same.length > 0) {
    const score = (m: MortgageRow) => (t.buyer?.stateId && m.buyerStateId === t.buyer.stateId ? 2 : 0) + (fits(m) ? 2 : 0);
    const best = [...same].sort((a, b) => score(b) - score(a) || (b.originatedAt?.getTime() ?? 0) - (a.originatedAt?.getTime() ?? 0))[0];
    const sc = score(best);
    return matchedTo(t, best, sc >= 4 ? "address, buyer and amounts" : sc >= 2 ? "address and buyer" : "address");
  }
  const renumbered = ctx.mortgages.filter((m) => !m.lastTabletAt && buyer !== null && m.buyerStateId === buyer && fits(m));
  if (renumbered.length === 1) return matchedTo(t, renumbered[0], "buyer and amounts (the address has changed)");

  const problems = problemsForNewMortgage(t);
  const candidates = duplicateCandidates(t, ctx.mortgages);
  if (candidates.length > 0) {
    return {
      kind: "possible_duplicate",
      newAllowed: problems.length === 0,
      problems,
      candidates: candidates.map((m) => ({
        id: m.id,
        address: m.address,
        priceCents: m.priceCents,
        loanCents: m.loanCents,
        originatedAt: m.originatedAt?.toISOString() ?? null,
        pasted: m.lastTabletAt !== null,
      })),
    };
  }
  if (problems.length > 0) return { kind: "refused", problems };
  return { kind: "new" };
}

/** An agreement not yet in the books is a new one, so the federal maximums apply to it (unknown date). */
function guidelinesFor(t: TabletMortgage, ctx: Ctx, self: { id: string; originatedAt: Date | null } | null): GuidelineFlag[] {
  const other = ctx.mortgages.some((m) => m.id !== self?.id && t.buyer?.stateId && m.buyerStateId === t.buyer.stateId && m.address !== t.address);
  return mortgageGuidelines(t, { buyerHasOtherMortgage: other, funding: fundingOf(t), originatedAt: self?.originatedAt ?? null }, ctx.guidelines);
}

export async function previewTablet(_viewer: Viewer, input: { text: string }): Promise<TabletPreview> {
  const { mortgages: parsed, ignoredLines } = parseOrThrow(input.text);
  await syncMortgages();
  const ctx = await context(db);
  const items: TabletPreviewItem[] = [];
  // One after another: each may look up the quote and officer behind it.
  for (const t of parsed) {
    const found = match(t, ctx);
    const { row, ...m } = found.kind === "matched" ? found : { ...found, row: undefined };
    const staffMatch = t.officer?.stateId ? ctx.staffByStateId.get(t.officer.stateId) : undefined;
    const unapproved =
      m.kind === "matched" || m.kind === "new" || m.kind === "possible_duplicate"
        ? await previewApprovalFlag({ ...t, buyerStateId: t.buyer?.stateId ?? null, officerStaffId: staffMatch?.id ?? null }, row ?? null, ctx.guidelines)
        : null;
    items.push({
      index: t.index,
      address: t.address,
      addressRecognised: t.addressRecognised,
      skippedLines: t.skippedLines,
      buyer: t.buyer,
      officer: t.officer ? { ...t.officer, staffId: staffMatch?.id ?? null, staffName: staffMatch?.name ?? null } : null,
      priceCents: t.priceCents,
      loanCents: t.loanCents,
      downPaymentCents: t.downPaymentCents,
      instalments: t.instalments,
      weeklyCents: t.weeklyCents,
      brokerRateBp: t.brokerRateBp,
      fedRateBp: t.fedRateBp,
      brokerFeeCents: t.brokerFeeCents,
      paidCount: t.paidCount,
      funding: fundingOf(t),
      warnings: t.warnings,
      guidelines: [...(unapproved ? [unapproved] : []), ...guidelinesFor(t, ctx, row ?? null)],
      match: m,
    });
  }
  return { ignoredLines, items };
}

export const commitTabletSchema = z.object({
  text: z.string().min(1, "Paste the agreement first.").max(MAX_TABLET_CHARS),
  /** For possible duplicates, by agreement index: the existing mortgage it is, "new", or "skip". */
  decisions: z.record(z.string().regex(/^\d+$/), z.union([z.uuid(), z.literal("new"), z.literal("skip")])).default({}),
});

export type CommitTabletResult = { pasteId: string; updated: number; created: number; ignored: number; refused: number; skipped: number };

function tabletFields(t: TabletMortgage) {
  return {
    funding: fundingOf(t),
    propertyType: t.propertyType,
    landCount: t.landCount,
    priceCents: t.priceCents,
    downPaymentCents: t.downPaymentCents,
    loanCents: t.loanCents,
    brokerInterestCents: t.brokerInterestCents,
    federalInterestCents: t.federalInterestCents,
    instalments: t.instalments,
    termMonths: t.termMonths,
    fedRateBp: t.fedRateBp,
    brokerRateBp: t.brokerRateBp,
    lateFeeCents: t.lateFeeCents,
    gracePeriodDays: t.gracePeriodDays,
    brokerFeeCents: t.brokerFeeCents,
    agencyCommissionCents: t.agencyCommissionCents,
    ownerName: t.owner,
    agencyName: t.agency,
    agentStateId: t.agent?.stateId ?? null,
    agentName: t.agent?.name ?? null,
    officerStateId: t.officer?.stateId ?? null,
    officerName: t.officer?.name ?? null,
    lastPaidCount: t.paidCount,
    lastRemainingCents: t.remainingCents,
  };
}

/** Drops nulls so a field missing from one paste never erases what an earlier paste recorded. */
function present<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined)) as Partial<T>;
}

export async function commitTablet(viewer: Viewer, raw: z.input<typeof commitTabletSchema>): Promise<CommitTabletResult> {
  const input = commitTabletSchema.parse(raw);
  const { mortgages: parsed } = parseOrThrow(input.text);
  const request = await getRequestMeta();

  return db.transaction(async (tx) => {
    await syncMortgages(tx);
    const ctx = await context(tx);
    const now = new Date();
    const pasteId = randomUUID();
    await tx.insert(mortgagePaste).values({ id: pasteId, capturedAt: now, createdByStaffId: viewer.staffId, count: parsed.length });
    let updated = 0;
    let created = 0;
    let ignored = 0;
    let refused = 0;
    let skipped = 0;

    for (const t of parsed) {
      let m = match(t, ctx);
      if (m.kind === "possible_duplicate") {
        // A person decides; the browser can only pick among the candidates the matcher offered.
        const decision = input.decisions[String(t.index)];
        const chosen = decision && decision !== "new" && decision !== "skip" ? m.candidates.find((c) => c.id === decision) : undefined;
        if (chosen) m = matchedTo(t, ctx.mortgages.find((r) => r.id === chosen.id)!, "chosen by hand");
        else if (decision === "skip") m = { kind: "ignored", reason: "skipped" };
        else if (decision === "new" && m.newAllowed) m = { kind: "new" };
        else if (decision === "new") throw new LoanError(`Agreement ${t.index + 1} can't be added as a new mortgage: ${m.problems.join(" ")}`);
        else throw new LoanError(`Say whether agreement ${t.index + 1} (${t.address}) is one of the buyer’s existing mortgages or a new one.`);
      }
      const officerStaff = t.officer?.stateId ? ctx.staffByStateId.get(t.officer.stateId) : undefined;
      let mortgageId: string | null = null;

      if (m.kind === "refused") {
        refused++;
      } else if (m.kind === "ignored") {
        if (m.reason === "skipped") skipped++;
        else ignored++;
      } else if (m.kind === "new") {
        // Re-checked here: nothing the browser sends can create an incomplete record.
        const problems = problemsForNewMortgage(t);
        if (problems.length) throw new LoanError(`Agreement ${t.index + 1} can't be added as a new mortgage: ${problems.join(" ")}`);
        mortgageId = randomUUID();
        await tx.insert(mortgage).values({
          id: mortgageId,
          address: t.address,
          buyerStateId: t.buyer?.stateId ?? null,
          buyerName: t.buyer?.name ?? null,
          officerStaffId: officerStaff?.id ?? null,
          lastTabletAt: now,
          ...present(tabletFields(t)),
        });
        await tx.insert(mortgageEvent).values({ mortgageId, at: now, kind: "created_from_tablet", staffId: viewer.staffId, detail: {} });
        const row = (await tx.select().from(mortgage).where(eq(mortgage.id, mortgageId)))[0];
        ctx.mortgages.push(row);
        created++;
      } else {
        const row = m.row!;
        mortgageId = row.id;
        await tx
          .update(mortgage)
          .set({
            ...present(tabletFields(t)),
            // The tablet shows the current address; keep the old one for linking repayments.
            ...(t.addressRecognised ? { address: t.address, addressAliases: withAlias(row.addressAliases, t.address, row.address) } : {}),
            buyerStateId: t.buyer?.stateId ?? row.buyerStateId,
            buyerName: t.buyer?.name ?? row.buyerName,
            officerStaffId: row.officerStaffId ?? officerStaff?.id ?? null,
            lastTabletAt: now,
            updatedAt: now,
          })
          .where(eq(mortgage.id, row.id));
        await tx.insert(mortgageEvent).values({
          mortgageId,
          at: now,
          kind: m.firstPaste ? "terms_set" : m.changes.length ? "terms_changed" : "tablet_seen",
          staffId: viewer.staffId,
          detail: { changes: m.changes, paidCount: t.paidCount },
        });
        if (!row.officerStaffId && officerStaff) {
          await tx.insert(mortgageEvent).values({ mortgageId, at: now, kind: "officer_assigned", staffId: viewer.staffId, detail: { from: null, to: officerStaff.id } });
        }
        updated++;
      }
      await tx.insert(mortgageSnapshot).values({ pasteId, mortgageId, raw: t.raw, parsed: t });
    }

    // Repayments made before the agreement was pasted can link now.
    await syncMortgages(tx);
    const result = { pasteId, updated, created, ignored, refused, skipped };
    await recordAudit(tx, {
      actor: { type: "staff", staffId: viewer.staffId },
      action: "mortgages.tablet.committed",
      target: { type: "mortgage_paste", id: pasteId },
      metadata: { ...result, addresses: parsed.map((p) => p.address) },
      request,
    });
    return result;
  });
}
