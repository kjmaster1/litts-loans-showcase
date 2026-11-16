import { percentOfCents } from "@/lib/money";
import { formatCents } from "@/lib/format";
import { mortgageGuidelines, mortgageSchedule, type GuidelineFlag } from "@/domain/mortgages/schedule";
import { DEFAULT_SETTINGS, type Settings } from "@/domain/settings";

/**
 * Mortgage quote (owner, 2026-10-10): what the tablet will produce for a set of terms,
 * so the officer can negotiate before typing anything in. Reproduces the tablet exactly
 * (all 27 sale agreements on record, research/15):
 *
 * - base = down payment + loan = price − the agency's commission;
 * - down payment, banker fee, broker and federal interest, and the 5% tax at signing are
 *   percentages rounded **up** to whole dollars;
 * - weekly payments = ⌈months × 52 / 12⌉; each instalment is loan/N + broker/N + federal/N,
 *   each rounded down, the last taking the remainder;
 * - the buyer pays down payment + banker fee + agency commission + tax at signing.
 * Pure.
 */

export type MortgageQuoteInput = {
  /** "Total Value" on the tablet (includes the agency's commission). */
  priceCents: number;
  agencyCommissionCents: number;
  /** Down payment as a % of down payment + loan (the tablet's minimum is 10%). */
  downPaymentPct: number;
  termMonths: number;
  fedRatePct: number;
  brokerRatePct: number;
  bankerFeePct: number;
  /** The buyer's first (primary) residence — fed rate minimum 3%, else 10% (handbook §4A). */
  primaryResidence: boolean;
  /**
   * Litt's lends the money (no fed rate on the tablet): exempt from the federal maximums, and the
   * fed rate doesn't apply.
   */
  companyFunded: boolean;
};

export type MortgageQuote = {
  baseCents: number;
  downPaymentCents: number;
  loanCents: number;
  instalments: number;
  bankerFeeCents: number;
  brokerInterestCents: number;
  federalInterestCents: number;
  weeklyCents: number;
  lastWeeklyCents: number;
  taxCents: number;
  dueAtSigningCents: number;
  afterTaxCents: number;
  /** Broker interest + banker fee: what Litt's earns over the mortgage. */
  littsEarnsCents: number;
  /** Loan-to-value, % of the base. */
  ltvPct: number;
};

/** A percentage of an amount in whole dollars, rounded up like the tablet — exact (integer basis points). */
const up = (cents: number, pct: number) => percentOfCents(cents, pct, "up");

export const TAX_AT_SIGNING_PCT = 5;

export function instalmentsFor(termMonths: number): number {
  return Math.ceil((termMonths * 52) / 12 - 1e-9);
}

export function quoteMortgage(q: MortgageQuoteInput): MortgageQuote {
  const baseCents = q.priceCents - q.agencyCommissionCents;
  const downPaymentCents = up(baseCents, q.downPaymentPct);
  const loanCents = baseCents - downPaymentCents;
  const instalments = instalmentsFor(q.termMonths);
  const bankerFeeCents = up(baseCents, q.bankerFeePct);
  const brokerInterestCents = up(loanCents, q.brokerRatePct);
  const federalInterestCents = q.companyFunded ? 0 : up(loanCents, q.fedRatePct);
  const taxCents = up(baseCents, TAX_AT_SIGNING_PCT);
  const schedule = mortgageSchedule({ loanCents, brokerInterestCents, federalInterestCents, instalments, originatedAt: new Date(0) });
  return {
    baseCents,
    downPaymentCents,
    loanCents,
    instalments,
    bankerFeeCents,
    brokerInterestCents,
    federalInterestCents,
    weeklyCents: schedule[0]?.totalCents ?? 0,
    lastWeeklyCents: schedule.at(-1)?.totalCents ?? 0,
    taxCents,
    dueAtSigningCents: downPaymentCents + bankerFeeCents + q.agencyCommissionCents + taxCents,
    afterTaxCents: q.priceCents + taxCents,
    littsEarnsCents: bankerFeeCents + brokerInterestCents,
    ltvPct: baseCents > 0 ? (loanCents / baseCents) * 100 : 0,
  };
}

/**
 * Checks on a quote: the federal maximums (`federalMaximumBreaches` — those block saving) and the
 * handbook §4A guidance (flags; the tablet enforces its own limits). A quote is for a mortgage
 * about to be arranged, so the maximums apply unless it's company-funded. `arrangedAt`: when a closed
 * quote's mortgage was arranged (null for an open quote — it's still to be typed in).
 */
export function quoteChecks(
  q: MortgageQuoteInput,
  figures: MortgageQuote,
  g: Settings["mortgages"] = DEFAULT_SETTINGS.mortgages,
  arrangedAt: Date | null = null,
): GuidelineFlag[] {
  const flags = mortgageGuidelines(
    {
      brokerRateBp: Math.round(q.brokerRatePct * 100),
      fedRateBp: q.companyFunded ? null : Math.round(q.fedRatePct * 100),
      brokerFeeCents: figures.bankerFeeCents,
      downPaymentCents: figures.downPaymentCents,
      loanCents: figures.loanCents,
    },
    { buyerHasOtherMortgage: !q.primaryResidence, funding: q.companyFunded ? "company" : "state", originatedAt: arrangedAt, bankerFeeBp: Math.round(q.bankerFeePct * 100) },
    g,
  ).filter((f) => !/primary residence/.test(f.text));
  if (!q.companyFunded && !q.primaryResidence && q.fedRatePct < g.fedRateSecondHomeMinPct) {
    flags.push({ level: "breach", text: `Not the buyer’s primary residence: the fed rate must be at least ${g.fedRateSecondHomeMinPct}%` });
  }
  if (q.downPaymentPct < g.downPaymentMinPct) flags.push({ level: "breach", text: `The tablet needs a down payment of at least ${g.downPaymentMinPct}%` });
  if (q.agencyCommissionCents >= q.priceCents) flags.push({ level: "breach", text: "The agency’s commission can’t be the whole price" });
  if (q.termMonths < 1 || q.termMonths > 12) flags.push({ level: "warning", text: "Terms on record run 1–12 months" });
  return flags;
}

/** The checks that stop a quote being saved: anything over the federal maximums (owner, 2026-10-15). */
export function federalMaximumBreaches(flags: GuidelineFlag[]): GuidelineFlag[] {
  return flags.filter((f) => f.rule === "federal_maximum");
}

/** Where the sale agreement differs from the quote (a figure typed differently into the tablet). */
export function quoteDifferences(
  q: MortgageQuote & { brokerRateBp: number; fedRateBp: number },
  m: { downPaymentCents: number | null; loanCents: number | null; brokerFeeCents: number | null; brokerRateBp: number | null; fedRateBp: number | null; instalments: number | null },
): string[] {
  const out: string[] = [];
  const $ = formatCents;
  const money = (label: string, quoted: number, actual: number | null) => {
    if (actual !== null && actual !== quoted) out.push(`${label} is ${$(actual)} on the agreement, ${$(quoted)} in the quote`);
  };
  money("Down payment", q.downPaymentCents, m.downPaymentCents);
  money("Loan", q.loanCents, m.loanCents);
  money("Banker fee", q.bankerFeeCents, m.brokerFeeCents);
  if (m.brokerRateBp !== null && m.brokerRateBp !== q.brokerRateBp) out.push(`Broker rate is ${m.brokerRateBp / 100}% on the agreement, ${q.brokerRateBp / 100}% in the quote`);
  if (m.fedRateBp !== null && m.fedRateBp !== q.fedRateBp) out.push(`Fed rate is ${m.fedRateBp / 100}% on the agreement, ${q.fedRateBp / 100}% in the quote`);
  if (m.instalments !== null && m.instalments !== q.instalments) out.push(`${m.instalments} weekly payments on the agreement, ${q.instalments} in the quote`);
  return out;
}
