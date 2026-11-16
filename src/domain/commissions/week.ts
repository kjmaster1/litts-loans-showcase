import { zonedMidnight, zonedParts } from "@/lib/company-time";

/**
 * Commission weeks: Monday 00:00 → next Monday 00:00, Europe/London (BST-aware).
 * A week is identified by its Monday's calendar date, e.g. "2026-10-12".
 */

/** The new scheme's first day (owner, research/08). */
export const COMMISSION_START_KEY = "2026-10-12";

const pad = (n: number) => String(n).padStart(2, "0");

export function weekKeyOf(date: Date): string {
  const { year, month, day } = zonedParts(date);
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0 = Sunday
  const monday = new Date(Date.UTC(year, month - 1, day - ((dow + 6) % 7)));
  return `${monday.getUTCFullYear()}-${pad(monday.getUTCMonth() + 1)}-${pad(monday.getUTCDate())}`;
}

export function isWeekKey(key: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCDate() === d && date.getUTCDay() === 1;
}

export function shiftWeek(key: string, weeks: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + weeks * 7));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** UTC instants bounding the week: [from, to). */
export function weekRange(key: string): { from: Date; to: Date } {
  const [y, m, d] = key.split("-").map(Number);
  const [ny, nm, nd] = shiftWeek(key, 1).split("-").map(Number);
  return { from: zonedMidnight(y, m, d), to: zonedMidnight(ny, nm, nd) };
}

export const COMMISSION_START = weekRange(COMMISSION_START_KEY).from;

/** Week keys from the start of the scheme up to and including the week containing `now`. */
export function weeksSinceStart(now: Date = new Date()): string[] {
  const keys: string[] = [];
  const current = weekKeyOf(now);
  for (let k = COMMISSION_START_KEY; k <= current; k = shiftWeek(k, 1)) keys.push(k);
  return keys;
}

export function weekLabel(key: string): string {
  const { from, to } = weekRange(key);
  const end = new Date(to.getTime() - 1);
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short" });
  return `${f.format(from)} – ${f.format(end)} ${zonedParts(end).year}`;
}

/**
 * The one-off catch-up period (owner, research/10): loan interest received after
 * the last hand-paid commission run and before the scheme started.
 */
export const CATCH_UP_KEY = "catch-up";
export const CATCH_UP_FROM = zonedMidnight(2026, 8, 25);

/** A weekly key from the start of the scheme, or the catch-up period. */
export function isPeriodKey(key: string): boolean {
  return key === CATCH_UP_KEY || (isWeekKey(key) && key >= COMMISSION_START_KEY);
}

export function periodRange(key: string): { from: Date; to: Date } {
  return key === CATCH_UP_KEY ? { from: CATCH_UP_FROM, to: COMMISSION_START } : weekRange(key);
}

export function periodLabel(key: string): string {
  if (key !== CATCH_UP_KEY) return weekLabel(key);
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short" });
  return `Catch-up · ${f.format(CATCH_UP_FROM)} – ${f.format(new Date(COMMISSION_START.getTime() - 1))} ${zonedParts(CATCH_UP_FROM).year}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "20 Sep" in UK time (Intl's en-GB says "Sept"). */
export function dayMonth(date: Date): string {
  const { month, day } = zonedParts(date);
  return `${day} ${MONTHS[month - 1]}`;
}
