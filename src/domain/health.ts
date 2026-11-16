/**
 * Portfolio health (research/12). Pure.
 *
 * The phone only tells us a loan's status *now*, so history is rebuilt from the
 * contract and the bank: at any moment a loan is *paying* (up to date), *behind*
 * (an instalment more than a day past the game's due date), *defaulted* (from its
 * first default), or finished — *repaid* or *written off*. The period is weekly
 * unless the card said otherwise (Default/Overdue/Complete cards don't say).
 */

import { gameDueDates } from "@/domain/loans/analysis";

const DAY = 86_400_000;
/** A payment a day late isn't "behind" yet. */
const GRACE = DAY;

export type HealthLoan = {
  id: string;
  openedAt: Date;
  principalCents: number;
  instalments: number;
  periodDays: number | null;
  brokerRateBp: number | null;
  completedAt: Date | null;
  firstDefaultAt: Date | null;
  writtenOffAt: Date | null;
  /** Borrower payments: `principalCents` is what came off the receivable (principal received + the State's levy). */
  payments: { at: Date; grossCents: number; principalCents: number }[];
  /**
   * When each instalment was paid (on time or late). The game dates the next instalment from the
   * previous payment, so these give the real due dates; without them the contract's are used.
   */
  instalmentsPaidAt?: Date[];
};

export type LoanState = "paying" | "behind" | "defaulted" | "repaid" | "written_off";
export const OPEN_STATES: readonly LoanState[] = ["paying", "behind", "defaulted"];

export function instalmentDates(l: Pick<HealthLoan, "openedAt" | "instalments" | "periodDays">): Date[] {
  const period = (l.periodDays ?? 7) * DAY;
  return Array.from({ length: l.instalments }, (_, i) => new Date(l.openedAt.getTime() + (i + 1) * period));
}

/**
 * When each instalment fell (or falls) due as the game sees it — a period after the previous one was
 * paid — from the payments known before `t` (all of them if omitted). The contract's dates otherwise.
 */
export function dueDates(l: Pick<HealthLoan, "openedAt" | "instalments" | "periodDays" | "instalmentsPaidAt">, t?: Date): Date[] {
  if (!l.instalmentsPaidAt) return instalmentDates(l);
  const paid = t ? l.instalmentsPaidAt.filter((p) => p < t) : l.instalmentsPaidAt;
  return gameDueDates({ openedAt: l.openedAt, periodDays: l.periodDays ?? 7, instalments: l.instalments }, paid);
}

/** Principal credited up to (not including) `t`. */
function principalBy(l: HealthLoan, t: Date): number {
  return l.payments.reduce((s, p) => (p.at < t ? s + p.principalCents : s), 0);
}

/** null before the loan was made. */
export function stateAt(l: HealthLoan, t: Date): LoanState | null {
  if (l.openedAt >= t) return null;
  if (l.completedAt && l.completedAt < t) return "repaid";
  if (l.writtenOffAt && l.writtenOffAt < t) return "written_off";
  if (l.firstDefaultAt && l.firstDefaultAt < t) return "defaulted";
  const due = dueDates(l, t).filter((d) => d.getTime() + GRACE < t.getTime()).length;
  const per = l.principalCents / l.instalments;
  // Small tolerance: the game rounds each instalment to whole dollars.
  const paid = Math.floor((principalBy(l, t) + 100 * l.instalments) / per);
  return paid < due ? "behind" : "paying";
}

export function owedAt(l: HealthLoan, t: Date): number {
  return Math.max(0, l.principalCents - principalBy(l, t));
}

export type Snapshot = { at: Date; count: Record<LoanState, number>; owed: Record<"paying" | "behind" | "defaulted", number>; atRiskShare: number };

export function snapshot(loans: HealthLoan[], t: Date): Snapshot {
  const count: Record<LoanState, number> = { paying: 0, behind: 0, defaulted: 0, repaid: 0, written_off: 0 };
  const owed = { paying: 0, behind: 0, defaulted: 0 };
  for (const l of loans) {
    const s = stateAt(l, t);
    if (!s) continue;
    count[s]++;
    if (s === "paying" || s === "behind" || s === "defaulted") owed[s] += owedAt(l, t);
  }
  const total = owed.paying + owed.behind + owed.defaulted;
  return { at: t, count, owed, atRiskShare: total ? (owed.behind + owed.defaulted) / total : 0 };
}

/** How loans moved between consecutive moments: from an open state to any state. */
export function rollMovement(loans: HealthLoan[], moments: Date[]): Record<"paying" | "behind" | "defaulted", Record<LoanState, number>> {
  const blank = (): Record<LoanState, number> => ({ paying: 0, behind: 0, defaulted: 0, repaid: 0, written_off: 0 });
  const out = { paying: blank(), behind: blank(), defaulted: blank() };
  for (let i = 1; i < moments.length; i++) {
    for (const l of loans) {
      const a = stateAt(l, moments[i - 1]);
      const b = stateAt(l, moments[i]);
      if (a === "paying" || a === "behind" || a === "defaulted") if (b) out[a][b]++;
    }
  }
  return out;
}

/**
 * Collected vs due in [from, to): due = instalments scheduled in the window on loans
 * not yet finished or defaulted when they fell due (P/N × (1 + broker rate) each);
 * collected = everything those borrowers paid in the window.
 */
export function collectionRate(loans: HealthLoan[], from: Date, to: Date): { dueCents: number; collectedCents: number; rate: number | null } {
  let due = 0;
  let collected = 0;
  for (const l of loans) {
    const each = (l.principalCents / l.instalments) * (1 + (l.brokerRateBp ?? 0) / 10_000);
    for (const d of dueDates(l)) {
      if (d < from || d >= to) continue;
      const s = stateAt(l, d);
      if (s === "paying" || s === "behind") due += each;
    }
    for (const p of l.payments) if (p.at >= from && p.at < to) collected += p.grossCents;
  }
  // The game only moves whole dollars.
  const dueCents = Math.round(due / 100) * 100;
  return { dueCents, collectedCents: collected, rate: dueCents > 0 ? collected / dueCents : null };
}

/** Was the loan ever behind schedule (checked just after each due date, while it was running)? */
export function everBehind(l: HealthLoan, now: Date): boolean {
  return dueDates(l).some((d) => {
    const t = new Date(d.getTime() + 2 * DAY);
    return t <= now && stateAt(l, t) === "behind";
  });
}

/** For a defaulted loan: what it owed when it defaulted, and how much of that came back afterwards. */
export function sinceDefault(l: HealthLoan): { owedCents: number; recoveredCents: number } | null {
  if (!l.firstDefaultAt) return null;
  const owed = owedAt(l, l.firstDefaultAt);
  const recovered = l.payments.reduce((s, p) => (p.at >= l.firstDefaultAt! ? s + p.principalCents : s), 0);
  return { owedCents: owed, recoveredCents: Math.min(owed, recovered) };
}
