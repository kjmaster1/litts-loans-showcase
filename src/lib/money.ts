/**
 * Money is stored as integer cents, but the game only ever moves whole dollars
 * (it rounds every amount), so anything the app *derives* — State levy,
 * schedules, adjustments — is rounded to whole dollars with `wholeDollars`.
 */

/** Rounds cents to the nearest whole dollar, as the game does (half away from zero). */
export function wholeDollars(cents: number): number {
  return Math.sign(cents) * Math.round(Math.abs(cents) / 100) * 100;
}

export function dollarsToCents(value: number): number {
  if (!Number.isFinite(value)) throw new RangeError(`Not a finite amount: ${value}`);
  return Math.round(value * 100);
}

const whole = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const exact = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

/** "$1,234" (or "$1,234.56" when there are cents); negatives as "−$1,234". */
export function formatCents(cents: number, opts: { parenthesesForNegative?: boolean } = {}): string {
  const abs = Math.abs(cents);
  const text = abs % 100 === 0 ? whole.format(abs / 100) : exact.format(abs / 100);
  if (cents >= 0) return text;
  return opts.parenthesesForNegative ? `(${text})` : `−${text}`;
}

/**
 * A percentage of an amount, in whole dollars, computed exactly (owner review 2026-10-11:
 * decimal rates like 6.1% times cents needed a floating-point fudge). The rate becomes whole
 * basis points once (6.1% → 610), then it's integer arithmetic: cents × bp / 1,000,000 dollars.
 * `up` rounds up (the tablet's rule); `nearest` rounds half away from zero (the game's).
 */
export function percentOfCents(cents: number, ratePct: number, rounding: "up" | "nearest"): number {
  const bp = Math.round(ratePct * 100);
  const n = cents * bp; // whole cent-basis-points: exact below 2^53
  const d = 1_000_000; // → whole dollars
  if (!Number.isSafeInteger(n)) throw new RangeError(`Amount too large: ${cents} × ${bp}bp`);
  const dollars = rounding === "up" ? Math.ceil(n / d) : Math.sign(n) * Math.floor((2 * Math.abs(n) + d) / (2 * d));
  return dollars * 100;
}
