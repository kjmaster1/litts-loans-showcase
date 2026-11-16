import { formatBp } from "@/lib/format";
import { percentOfCents, wholeDollars } from "@/lib/money";
import { DEFAULT_SETTINGS, type Settings } from "@/domain/settings";

/**
 * New private loans (owner, 2026-10-10; handbook §4B–C). Pure.
 *
 * The contract states the total repayable, P × (1 + rate) — flat interest, never
 * compounding — split into equal weekly payments in whole dollars, the last taking the
 * remainder. (The game then never charges the final instalment's interest — a known
 * quirk, research/14 — so the borrower usually pays a little less than the contract.)
 */

export const LOAN_KINDS = ["vehicle", "property", "general"] as const;
export type LoanKind = (typeof LOAN_KINDS)[number];
export const LOAN_KIND_LABEL: Record<LoanKind, string> = { vehicle: "Motor vehicle loan", property: "Property loan", general: "Personal loan" };

export type OfferTerms = {
  amountCents: number;
  ratePct: number;
  stateRatePct: number;
  weeks: number;
  /** Contract date; the first payment is a week later. */
  startsOn: Date;
  /** Value of the vehicle/property/asset pledged, if any. */
  collateralValueCents: number | null;
  /** The borrower's stated weekly income, if given. */
  weeklyIncomeCents: number | null;
};

export type OfferFigures = {
  totalCents: number;
  interestCents: number;
  weeklyCents: number;
  lastCents: number;
  schedule: { number: number; dueOn: Date; cents: number }[];
  ltvPct: number | null;
  paymentToIncomePct: number | null;
  /** The State's share of the principal (it comes off what Litt's gets back). */
  stateShareCents: number;
  /** Interest less the State's share, before tax and commission. */
  littsEarnsCents: number;
};

const DAY = 86_400_000;

export function offerFigures(t: OfferTerms): OfferFigures {
  // Exact: rates become whole basis points before any arithmetic (lib/money percentOfCents).
  const interestCents = percentOfCents(t.amountCents, t.ratePct, "nearest");
  const totalCents = t.amountCents + interestCents;
  const weeks = Math.max(1, Math.round(t.weeks));
  const weeklyCents = wholeDollars(totalCents / weeks);
  const lastCents = totalCents - weeklyCents * (weeks - 1);
  const schedule = Array.from({ length: weeks }, (_, i) => ({
    number: i + 1,
    dueOn: new Date(t.startsOn.getTime() + (i + 1) * 7 * DAY),
    cents: i === weeks - 1 ? lastCents : weeklyCents,
  }));
  const stateShareCents = percentOfCents(t.amountCents, t.stateRatePct, "nearest");
  return {
    totalCents,
    interestCents,
    weeklyCents,
    lastCents,
    schedule,
    ltvPct: t.collateralValueCents ? (t.amountCents / t.collateralValueCents) * 100 : null,
    paymentToIncomePct: t.weeklyIncomeCents ? (weeklyCents / t.weeklyIncomeCents) * 100 : null,
    stateShareCents,
    littsEarnsCents: interestCents - stateShareCents,
  };
}

/** What the company knows about the borrower, for the rate guide. */
export type BorrowerRecord = { repaid: number; wentBad: number; open: number; doNotLend: boolean };

export type RateSuggestion = { ratePct: number; reasons: { text: string; deltaPct: number }[]; clamped: boolean };

/**
 * A starting rate from the handbook's determination factors (§4C: asset value, amount,
 * loan-to-value, weekly payment feasibility) plus the borrower's record with Litt's.
 * A suggestion with its reasons shown — the officer sets the rate.
 */
export function suggestRate(kind: LoanKind, t: OfferTerms, record: BorrowerRecord, g: Settings["loans"] = DEFAULT_SETTINGS.loans): RateSuggestion {
  const reasons: RateSuggestion["reasons"] = [];
  const add = (text: string, deltaPct: number) => reasons.push({ text, deltaPct });
  const base = 15;
  const f = offerFigures({ ...t, ratePct: base });

  if (!t.collateralValueCents) add(kind === "general" ? "No collateral pledged" : "Collateral value not given", 4);
  else if (f.ltvPct! <= 50) add(`Loan is ${Math.round(f.ltvPct!)}% of the collateral’s value`, -3);
  else if (f.ltvPct! <= 75) add(`Loan is ${Math.round(f.ltvPct!)}% of the collateral’s value`, -1);
  else if (f.ltvPct! <= 100) add(`Loan is ${Math.round(f.ltvPct!)}% of the collateral’s value`, 1);
  else add(`Loan is more than the collateral is worth (${Math.round(f.ltvPct!)}%)`, 4);

  if (t.amountCents >= 10_000_000) add("Large loan ($100,000 or more)", 2);
  else if (t.amountCents <= 1_000_000) add("Small loan ($10,000 or less)", 1);

  if (t.weeks > 16) add(`Long term (${t.weeks} weeks)`, 3);
  else if (t.weeks > 8) add(`Term over 8 weeks (${t.weeks})`, 1);
  else if (t.weeks <= 4) add(`Short term (${t.weeks} weeks)`, -1);

  if (f.paymentToIncomePct === null) add("Weekly income not given", 1);
  else if (f.paymentToIncomePct > g.maxPaymentToIncomePct) add(`Weekly payment is ${Math.round(f.paymentToIncomePct)}% of their income`, 3);
  else if (f.paymentToIncomePct <= 20) add(`Weekly payment is only ${Math.round(f.paymentToIncomePct)}% of their income`, -1);

  if (record.wentBad > 0) add(`${record.wentBad} past loan${record.wentBad === 1 ? "" : "s"} went bad`, 5);
  else if (record.repaid >= 2) add(`Repaid ${record.repaid} loans in full`, -2);
  else if (record.repaid === 1) add("Repaid a loan in full", -1);
  else add("First loan with Litt’s", 1);
  if (record.open > 0) add(`Already has ${record.open} loan${record.open === 1 ? "" : "s"} running`, 1);

  const raw = base + reasons.reduce((s, r) => s + r.deltaPct, 0);
  const ratePct = Math.min(g.rateMaxPct, Math.max(g.rateMinPct, Math.round(raw * 2) / 2));
  return { ratePct, reasons, clamped: ratePct !== raw };
}

export type OfferFlag = { level: "danger" | "warning" | "info"; text: string };

/** Handbook §4B and the company's own checks. Warnings only (owner): never blocks a contract. */
export function offerChecks(kind: LoanKind, t: OfferTerms & { defaultFeePerDayCents: number }, f: OfferFigures, g: Settings["loans"] = DEFAULT_SETTINGS.loans): OfferFlag[] {
  const flags: OfferFlag[] = [];
  if (t.ratePct < g.rateMinPct || t.ratePct > g.rateMaxPct) {
    flags.push({ level: "warning", text: `${t.ratePct}% is outside the ${g.rateMinPct}–${g.rateMaxPct}% range: it needs Executive Management sign-off (handbook §4B)` });
  }
  if (t.stateRatePct !== g.stateRatePct) flags.push({ level: "warning", text: `Enter ${g.stateRatePct}% as the State rate in the game, not ${t.stateRatePct}%` });
  if (t.stateRatePct >= t.ratePct) flags.push({ level: "danger", text: "The State’s rate is at or above the interest rate, so Litt’s would lose money" });
  if (kind !== "general" && !t.collateralValueCents) flags.push({ level: "info", text: `Add the ${kind === "vehicle" ? "vehicle’s" : "property’s"} value to check the loan-to-value` });
  if (f.ltvPct !== null && f.ltvPct > 100) flags.push({ level: "warning", text: `The loan is ${Math.round(f.ltvPct)}% of the collateral’s value, more than it’s worth` });
  if (f.paymentToIncomePct === null) flags.push({ level: "info", text: "Ask for their weekly income to check they can afford it" });
  else if (f.paymentToIncomePct > g.maxPaymentToIncomePct) {
    flags.push({ level: "warning", text: `The weekly payment is ${Math.round(f.paymentToIncomePct)}% of their weekly income (guideline: at most ${g.maxPaymentToIncomePct}%)` });
  }
  if (t.defaultFeePerDayCents <= 0) flags.push({ level: "warning", text: "Set a Defaulted Account Fee" });
  return flags;
}

/** Suggested Defaulted Account Fee per day: a share of the loan, to the nearest $50 (the officer chooses). */
export function suggestedDefaultFee(amountCents: number, g: Settings["loans"] = DEFAULT_SETTINGS.loans): number {
  return Math.max(5_000, Math.round((amountCents * g.defaultFeePerDayPct) / 100 / 5_000) * 5_000);
}

/** Where the phone card's terms differ from the contract (e.g. the rates typed the wrong way round). */
export function contractDifferences(
  contract: { amountCents: number; rateBp: number; stateRateBp: number; weeks: number },
  card: { principalCents: number; brokerRateBp: number | null; stateRateBp: number | null; instalments: number | null },
): string[] {
  const out: string[] = [];
  const pct = formatBp;
  if (card.principalCents !== contract.amountCents) out.push(`Amount paid out ${card.principalCents / 100} vs ${contract.amountCents / 100} in the contract`);
  if (card.brokerRateBp !== null && card.brokerRateBp !== contract.rateBp) out.push(`Interest rate on the card is ${pct(card.brokerRateBp)}, the contract says ${pct(contract.rateBp)}`);
  if (card.stateRateBp !== null && card.stateRateBp !== contract.stateRateBp) out.push(`State rate on the card is ${pct(card.stateRateBp)}, it should be ${pct(contract.stateRateBp)}`);
  if (card.instalments !== null && card.instalments !== contract.weeks) out.push(`The card has ${card.instalments} payments, the contract ${contract.weeks}`);
  return out;
}
