import { federalBreaches, federalMaximumsApply } from "@/domain/mortgages/federal";
import type { Funding } from "@/domain/mortgages/identity";
import { DEFAULT_SETTINGS, type Settings } from "@/domain/settings";
/**
 * Mortgage contract schedule and payment state (docs/design/MORTGAGES.md). Pure.
 *
 * The game splits each part per week rounding *down* to whole dollars, and the
 * last instalment takes the remainder (117 Invention Ct: loan $620,447 / 52 →
 * $11,931 a week, last $11,966; weekly total $13,003).
 */

export type MortgageTerms = {
  loanCents: number;
  brokerInterestCents: number;
  federalInterestCents: number;
  instalments: number;
  originatedAt: Date;
  gracePeriodDays: number;
};

export type MortgageInstalment = {
  number: number;
  dueAt: Date;
  principalCents: number;
  brokerInterestCents: number;
  federalInterestCents: number;
  /** What the buyer pays (gross, federal interest included). */
  totalCents: number;
};

const DAY_MS = 86_400_000;
const WEEK_DAYS = 7;

function split(totalCents: number, n: number): number[] {
  const each = Math.floor(totalCents / n / 100) * 100;
  return Array.from({ length: n }, (_, i) => (i === n - 1 ? totalCents - each * (n - 1) : each));
}

export function mortgageSchedule(t: Omit<MortgageTerms, "gracePeriodDays">): MortgageInstalment[] {
  const p = split(t.loanCents, t.instalments);
  const b = split(t.brokerInterestCents, t.instalments);
  const f = split(t.federalInterestCents, t.instalments);
  return p.map((principal, i) => ({
    number: i + 1,
    dueAt: new Date(t.originatedAt.getTime() + (i + 1) * WEEK_DAYS * DAY_MS),
    principalCents: principal,
    brokerInterestCents: b[i],
    federalInterestCents: f[i],
    totalCents: principal + b[i] + f[i],
  }));
}

export type MortgagePayment = { txId: string; occurredAt: Date; grossCents: number; taxCents: number; toStateCents: number | null };

export type PaymentState =
  | { kind: "completed" }
  | { kind: "on_track"; nextDueAt: Date | null }
  | { kind: "late"; overdue: number; graceEndsAt: Date }
  | { kind: "behind"; overdue: number; since: Date };

export type MortgageAnalysis = {
  schedule: MortgageInstalment[];
  /** Instalment number → the repayment matched to it (in order). */
  matched: { instalment: MortgageInstalment; payment: MortgagePayment | null; differenceCents: number | null }[];
  paidCount: number;
  state: PaymentState;
  brokerInterestReceivedCents: number;
  brokerInterestRemainingCents: number;
  principalRemainingCents: number;
};

/** Repayments are applied to instalments in order (the game has no partial payments). */
export function analyseMortgage(t: MortgageTerms, payments: MortgagePayment[], now: Date = new Date()): MortgageAnalysis {
  const schedule = mortgageSchedule(t);
  const sorted = [...payments].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  const matched = schedule.map((instalment, i) => {
    const payment = sorted[i] ?? null;
    return { instalment, payment, differenceCents: payment ? payment.grossCents - instalment.totalCents : null };
  });
  const paidCount = Math.min(sorted.length, schedule.length);
  const paid = matched.slice(0, paidCount);
  const brokerReceived = paid.reduce((s, m) => s + (m.payment && m.payment.toStateCents !== null ? m.payment.grossCents - m.payment.taxCents - m.payment.toStateCents : m.instalment.brokerInterestCents), 0);

  let state: PaymentState;
  if (paidCount >= schedule.length) state = { kind: "completed" };
  else {
    const due = schedule.filter((s) => s.dueAt <= now);
    const overdue = due.length - paidCount;
    const firstMissed = schedule[paidCount];
    if (overdue <= 0) state = { kind: "on_track", nextDueAt: firstMissed?.dueAt ?? null };
    else {
      const graceEndsAt = new Date(firstMissed.dueAt.getTime() + t.gracePeriodDays * DAY_MS);
      state = now <= graceEndsAt ? { kind: "late", overdue, graceEndsAt } : { kind: "behind", overdue, since: firstMissed.dueAt };
    }
  }

  return {
    schedule,
    matched,
    paidCount,
    state,
    brokerInterestReceivedCents: brokerReceived,
    brokerInterestRemainingCents: schedule.slice(paidCount).reduce((s, r) => s + r.brokerInterestCents, 0),
    principalRemainingCents: schedule.slice(paidCount).reduce((s, r) => s + r.principalCents, 0),
  };
}

/** `federal_maximum`: over the band's federal maximum — a quote with one can't be saved. */
export type GuidelineFlag = { level: "breach" | "warning"; text: string; rule?: "federal_maximum" | "executive_approval" };

/** The banker fee is a percentage of down payment + loan amount (owner, 2026-10-09). */
export function bankerFeeBasis(m: { downPaymentCents: number | null; loanCents: number | null }): number | null {
  return m.downPaymentCents !== null && m.loanCents !== null ? m.downPaymentCents + m.loanCents : null;
}

/**
 * Guideline flags for a mortgage's terms (research/04, 17): the federal maximums for State-funded
 * mortgages arranged from 15 Oct 2026 (`federal.ts`), and the fed-rate minimums. Flags only — the
 * terms already happened in game; quotes are where the maximums are enforced.
 */
export function mortgageGuidelines(
  m: { brokerRateBp: number | null; fedRateBp: number | null; brokerFeeCents: number | null; downPaymentCents: number | null; loanCents: number | null },
  opts: { buyerHasOtherMortgage: boolean; funding: Funding; originatedAt: Date | null; bankerFeeBp?: number },
  g: Settings["mortgages"] = DEFAULT_SETTINGS.mortgages,
): GuidelineFlag[] {
  const flags: GuidelineFlag[] = [];
  const bp = (pct: number) => Math.round(pct * 100);
  if (federalMaximumsApply(opts)) {
    const terms = { baseCents: bankerFeeBasis(m), brokerRateBp: m.brokerRateBp, bankerFeeCents: m.brokerFeeCents, bankerFeeBp: opts.bankerFeeBp };
    for (const text of federalBreaches(terms, g)) flags.push({ level: "breach", text, rule: "federal_maximum" });
  }
  if (m.fedRateBp !== null) {
    if (m.fedRateBp < bp(g.fedRateMinPct)) flags.push({ level: "breach", text: `Fed rate ${m.fedRateBp / 100}% is below the ${g.fedRateMinPct}% minimum` });
    else if (m.fedRateBp < bp(g.fedRateSecondHomeMinPct) && opts.buyerHasOtherMortgage) {
      flags.push({
        level: "warning",
        text: `Fed rate ${m.fedRateBp / 100}%: the buyer already has a Litt's mortgage, so this may not be their primary residence (${g.fedRateSecondHomeMinPct}% minimum)`,
      });
    }
  }
  return flags;
}
