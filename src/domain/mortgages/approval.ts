import { zonedMidnight } from "@/lib/company-time";
import { formatCents } from "@/lib/format";
import type { GuidelineFlag } from "@/domain/mortgages/schedule";
import type { Settings } from "@/domain/settings";

/**
 * Executive approval for large mortgages (owner, 2026-10-15; research/18). A mortgage whose down
 * payment + loan is over the line in settings ($1,000,000) needs an executive (Owner, CEO, COO) to
 * approve it, State- or company-funded. On a quote, the officer waits for the approval before
 * typing it into the tablet; an executive's own quote is approved when they save it. A tablet
 * agreement can't be stopped, so one that wasn't approved is recorded and flagged. Pure.
 */

export const EXECUTIVE_APPROVAL_FROM = zonedMidnight(2026, 10, 15);

/** The line in cents: amounts strictly above it need approval. */
export const approvalLineCents = (g: Settings["mortgages"]) => g.executiveApprovalAboveDollars * 100;

export function needsExecutiveApproval(baseCents: number | null, g: Settings["mortgages"]): boolean {
  return baseCents !== null && baseCents > approvalLineCents(g);
}

export type QuoteApproval = "not_needed" | "needed" | "approved";

/** Where a quote stands. An approval stays good only as long as the terms it approved (cleared on edit). */
export function quoteApproval(q: { baseCents: number; approvedAt: Date | null }, g: Settings["mortgages"]): QuoteApproval {
  if (!needsExecutiveApproval(q.baseCents, g)) return "not_needed";
  return q.approvedAt ? "approved" : "needed";
}

/** The fields of a quote an approval covers: changing any of them clears it. Notes and the buyer's spelling don't. */
export const APPROVED_TERMS = [
  "buyerStateId",
  "address",
  "priceCents",
  "agencyCommissionCents",
  "downPaymentBp",
  "termMonths",
  "fedRateBp",
  "brokerRateBp",
  "bankerFeeBp",
  "primaryResidence",
  "companyFunded",
] as const;

type Terms = Record<(typeof APPROVED_TERMS)[number], unknown>;

export function approvedTermsChanged(before: Terms, after: Terms): boolean {
  return APPROVED_TERMS.some((k) => before[k] !== after[k]);
}

/** What the app knows about a mortgage that may show it was approved. */
export type ApprovalEvidence = {
  /** The officer who arranged it is an executive: they approve their own. */
  officerIsExecutive: boolean;
  /** The quote it was made from, if any: when it was approved, and where the agreement differs from it. */
  quote: { number: number; approvedAt: Date | null; approvedByName?: string | null; differences: string[] } | null;
  /** An executive approved the mortgage itself, after it was arranged. */
  approvedAfter: { at: Date; byName: string | null } | null;
};

export type MortgageApproval =
  | { required: false }
  | { required: true; approved: true; how: "executive_officer" | "quote" | "after_the_fact" }
  | { required: true; approved: false; reason: string };

/** Whether the rule covers a mortgage: over the line and arranged since it started (unknown date = new). */
export function approvalApplies(m: { downPaymentCents: number | null; loanCents: number | null; originatedAt: Date | null }, g: Settings["mortgages"]): boolean {
  if (m.downPaymentCents === null || m.loanCents === null) return false;
  return needsExecutiveApproval(m.downPaymentCents + m.loanCents, g) && (m.originatedAt === null || m.originatedAt >= EXECUTIVE_APPROVAL_FROM);
}

export function mortgageApproval(
  m: { downPaymentCents: number | null; loanCents: number | null; originatedAt: Date | null },
  e: ApprovalEvidence,
  g: Settings["mortgages"],
): MortgageApproval {
  if (!approvalApplies(m, g)) return { required: false };
  if (e.approvedAfter) return { required: true, approved: true, how: "after_the_fact" };
  if (e.officerIsExecutive) return { required: true, approved: true, how: "executive_officer" };
  const q = e.quote;
  if (!q) return { required: true, approved: false, reason: "it wasn’t made from a quote" };
  if (!q.approvedAt) return { required: true, approved: false, reason: `quote #${q.number} wasn’t approved` };
  // Typed into the tablet before the approval came through.
  if (m.originatedAt && q.approvedAt > m.originatedAt) return { required: true, approved: false, reason: `quote #${q.number} was approved only after the agreement was signed` };
  // An approval covers the quoted terms, not whatever ended up on the tablet.
  if (q.differences.length) return { required: true, approved: false, reason: `the agreement differs from approved quote #${q.number}` };
  return { required: true, approved: true, how: "quote" };
}

/** The red flag for a mortgage over the line that no executive approved. */
export function approvalFlag(
  m: { downPaymentCents: number | null; loanCents: number | null; originatedAt: Date | null },
  e: ApprovalEvidence,
  g: Settings["mortgages"],
): GuidelineFlag | null {
  const a = mortgageApproval(m, e, g);
  if (!a.required || a.approved) return null;
  return {
    level: "breach",
    text: `Not approved by an executive: ${formatCents(m.downPaymentCents! + m.loanCents!)} down payment + loan is over ${formatCents(approvalLineCents(g))}, and ${a.reason}`,
    rule: "executive_approval",
  };
}
