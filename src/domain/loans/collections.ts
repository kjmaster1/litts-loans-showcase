/**
 * Collections rules (research/12). Pure.
 *
 * A promise to pay is *kept* once the borrower has paid at least the promised
 * amount between the promise being logged and the end of the promised day (UK);
 * *broken* if that day has passed without it; *pending* until then. A broken
 * promise is the strongest sign a borrower won't pay, so it lifts them to the top
 * of the list.
 */

export type PromiseOutcome = { state: "kept" | "broken" | "pending"; paidCents: number };

const DAY_MS = 86_400_000;

export function promiseOutcome(
  promise: { loggedAt: Date; promiseCents: number; promiseBy: Date },
  /** Borrower payments on the loan or mortgage (any part: principal, interest, fees). */
  payments: { at: Date; cents: number }[],
  now: Date,
): PromiseOutcome {
  // promiseBy is stored as noon UTC on the chosen day; the day ends at midnight after it.
  const deadline = new Date(Date.UTC(promise.promiseBy.getUTCFullYear(), promise.promiseBy.getUTCMonth(), promise.promiseBy.getUTCDate()) + DAY_MS);
  const paidCents = payments.filter((p) => p.at >= promise.loggedAt && p.at < deadline).reduce((s, p) => s + p.cents, 0);
  if (paidCents >= promise.promiseCents) return { state: "kept", paidCents };
  return { state: now >= deadline ? "broken" : "pending", paidCents };
}

/**
 * Who to chase first: more money, more missed payments, broken promises and a
 * follow-up that's come due all push a case up; one with a promise still pending
 * waits. A score, not money — only the order matters.
 */
export function collectionPriority(c: {
  owedCents: number;
  /** Missed instalments (defaulted counts as at least 3). */
  missed: number;
  brokenPromises: number;
  pendingPromise: boolean;
  followUpDue: boolean;
  neverContacted: boolean;
}): number {
  const size = Math.log10(Math.max(100, c.owedCents / 100)); // $100 → 2, $10k → 4, $1m → 6
  let score = size * (1 + Math.min(c.missed, 6) * 0.5);
  score *= 1 + c.brokenPromises;
  if (c.followUpDue || c.neverContacted) score *= 1.5;
  if (c.pendingPromise) score *= 0.4;
  return Math.round(score * 100) / 100;
}
