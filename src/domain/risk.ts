/**
 * Expected losses (research/12): a figure only — never booked. Loss rates come
 * from Litt's own history, by where a loan is now:
 *
 * - **Paying** (active): of loans that reached an outcome (repaid, defaulted or
 *   written off), the share that went bad.
 * - **Overdue**: the same, among loans that were ever overdue.
 * - **Defaulted**: among loans that ever defaulted, the share that never came back
 *   to be repaid.
 *
 * Each is multiplied by the share of a bad debt that's never recovered (of what
 * loans that went bad owed when they defaulted, the part never paid back), then by
 * what's still owed. A bucket with too little
 * history borrows the rate of the bucket before it, so a small sample can't
 * produce a silly number. Pure.
 */

export type RiskBucket = "active" | "overdue" | "defaulted";

export type LoanHistory = {
  status: "active" | "overdue" | "defaulted" | "written_off" | "completed";
  everOverdue: boolean;
  everDefaulted: boolean;
};

export type BucketRate = { rate: number; bad: number; of: number; borrowed: boolean };
export type LossRates = Record<RiskBucket, BucketRate> & {
  /** Share of a bad debt that's never recovered. */
  lossGivenDefault: number;
};

/** Fewer outcomes than this and a bucket borrows the rate before it. */
export const MIN_SAMPLE = 5;

const bad = (h: LoanHistory) => h.status === "defaulted" || h.status === "written_off";

export function lossRates(history: LoanHistory[], badDebts: { owedCents: number; recoveredCents: number }): LossRates {
  const outcome = history.filter((h) => h.status !== "active" && h.status !== "overdue");
  const rate = (list: LoanHistory[], isBad: (h: LoanHistory) => boolean, fallback: number): BucketRate => {
    const n = list.filter(isBad).length;
    return list.length >= MIN_SAMPLE ? { rate: n / list.length, bad: n, of: list.length, borrowed: false } : { rate: fallback, bad: n, of: list.length, borrowed: true };
  };
  const active = rate(outcome, bad, 0);
  const overdue = rate(
    outcome.filter((h) => h.everOverdue || h.everDefaulted),
    bad,
    active.rate,
  );
  // Once defaulted, "bad" means it never came back to be repaid.
  const defaulted = rate(
    history.filter((h) => h.everDefaulted),
    (h) => h.status !== "completed",
    Math.max(overdue.rate, 1),
  );
  const lossGivenDefault = badDebts.owedCents > 0 ? clamp01(1 - badDebts.recoveredCents / badDebts.owedCents) : 1;
  return { active, overdue, defaulted, lossGivenDefault };
}

export function expectedLoss(owedCents: number, bucket: RiskBucket, rates: LossRates): number {
  if (owedCents <= 0) return 0;
  // Whole dollars, like every figure the app derives.
  return Math.round((owedCents * rates[bucket].rate * rates.lossGivenDefault) / 100) * 100;
}

function clamp01(x: number) {
  return Math.min(1, Math.max(0, x));
}
