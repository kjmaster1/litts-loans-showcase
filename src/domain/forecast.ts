import { weekKeyOf, weekRange } from "@/domain/commissions/week";
import { FINAL_INSTALMENT_INTEREST_CHARGED } from "@/domain/loans/analysis";
import { wholeDollars } from "@/lib/money";

/**
 * Cash-flow forecast (research/11): what running loans and mortgages should pay
 * Litt's, week by week (London weeks), from their contract schedules. Pure.
 * Before tax withheld at source; defaulted loans excluded.
 */

export type InflowSource = "loans" | "mortgages";
export type Inflow = { at: Date; cents: number; source: InflowSource };

const DAY_MS = 86_400_000;

/**
 * The principal of each instalment still to come (QA 2026-10-10). The books decide
 * how much is still owed; the contract schedule after the phone's "completed" count
 * decides how it splits. Money owed beyond the schedule (missed payments) is due
 * with the next instalment. A balance below it (paid early) shrinks every remaining
 * instalment in proportion — the game keeps the number of instalments and scales
 * them by what's left (audit F4: Morgan Lockhart 0.919, Onyx Greystone 0.023).
 * Gross: the State's share comes off each instalment later.
 */
export function remainingPrincipal(l: { principalCents: number; instalments: number | null; completed: number | null; outstandingCents: number | null }): number[] {
  const owed = Math.max(0, l.outstandingCents ?? 0);
  if (owed === 0) return [];
  if (!l.instalments) return [owed];
  const per = wholeDollars(l.principalCents / l.instalments);
  const schedule = Array.from({ length: l.instalments }, (_, i) => (i === l.instalments! - 1 ? l.principalCents - per * (l.instalments! - 1) : per));
  const left = schedule.slice(Math.max(0, l.completed ?? 0));
  if (left.length === 0) return [owed];
  const planned = left.reduce((s, p) => s + p, 0);
  if (owed >= planned) {
    left[0] += owed - planned;
    return left;
  }
  const scaled = left.map((p) => wholeDollars((p * owed) / planned));
  // Whole dollars like the game; the last instalment takes the remainder.
  scaled[scaled.length - 1] = owed - scaled.slice(0, -1).reduce((s, p) => s + p, 0);
  return scaled;
}

export type LoanForForecast = {
  principalCents: number;
  instalments: number | null;
  periodDays: number | null;
  brokerRateBp: number | null;
  stateRateBp: number | null;
  openedAt: Date | null;
  completed: number | null;
  nextPaymentDueAt: Date | null;
  /** Principal still owed per the books. */
  outstandingCents: number | null;
};
export type LoanInflow = Inflow & { principalCents: number; interestCents: number; stateShareCents: number };

/**
 * A running loan's remaining instalments as Litt's receives them: principal less
 * the State's share, plus interest on that principal. The first falls on the
 * phone's next-payment time when known (else the schedule, else now), the rest
 * every period after it. The same figures feed "Expected to receive".
 * Game quirk: the final instalment carries no interest (the game never charges it).
 */
export function loanInflows(l: LoanForForecast, now: Date = new Date()): LoanInflow[] {
  const periodDays = l.periodDays ?? 7;
  const parts = remainingPrincipal(l);
  const scheduled = l.instalments && l.openedAt ? new Date(l.openedAt.getTime() + (Math.max(0, l.completed ?? 0) + 1) * periodDays * DAY_MS) : null;
  const first = l.nextPaymentDueAt ?? scheduled ?? now;
  // Do the parts run to the contract's final instalment?
  const reachesFinal = l.instalments !== null && parts.length === l.instalments - Math.min(l.instalments, Math.max(0, l.completed ?? 0));
  return parts.map((p, i) => {
    const final = reachesFinal && i === parts.length - 1 && !FINAL_INSTALMENT_INTEREST_CHARGED;
    const interestCents = l.brokerRateBp === null || final ? 0 : wholeDollars((p * l.brokerRateBp) / 10_000);
    const stateShareCents = wholeDollars((p * (l.stateRateBp ?? 0)) / 10_000);
    return {
      at: new Date(first.getTime() + i * periodDays * DAY_MS),
      cents: p - stateShareCents + interestCents,
      principalCents: p,
      interestCents,
      stateShareCents,
      source: "loans" as const,
    };
  });
}

export type ForecastWeek = { key: string; from: Date; loansCents: number; mortgagesCents: number; totalCents: number };
export type Forecast = {
  /** Due before this week and not paid yet — may still come in. */
  overdue: ForecastWeek;
  weeks: ForecastWeek[];
  later: ForecastWeek;
  totalCents: number;
};

const empty = (key: string, from: Date): ForecastWeek => ({ key, from, loansCents: 0, mortgagesCents: 0, totalCents: 0 });

export function forecastByWeek(inflows: Inflow[], now: Date, weeks = 8): Forecast {
  const thisWeek = weekKeyOf(now);
  const start = weekRange(thisWeek).from;
  const buckets: ForecastWeek[] = [];
  let key = thisWeek;
  for (let i = 0; i < weeks; i++) {
    const { from, to } = weekRange(key);
    buckets.push(empty(key, from));
    key = weekKeyOf(to);
  }
  const end = weekRange(buckets[buckets.length - 1].key).to;
  const overdue = empty("overdue", start);
  const later = empty("later", end);
  const add = (b: ForecastWeek, f: Inflow) => {
    if (f.source === "loans") b.loansCents += f.cents;
    else b.mortgagesCents += f.cents;
    b.totalCents += f.cents;
  };
  for (const f of inflows) {
    if (f.at < start) add(overdue, f);
    else if (f.at >= end) add(later, f);
    else add(buckets.find((b) => b.key === weekKeyOf(f.at))!, f);
  }
  return { overdue, weeks: buckets, later, totalCents: inflows.reduce((s, f) => s + f.cents, 0) };
}
