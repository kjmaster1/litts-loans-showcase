/**
 * The app's text formatting, in one place (owner review 2026-10-11: hand-rolled
 * `toLocaleString` calls had drifted — a missing "$", "Sept" next to "Oct"). Pure; safe on
 * the client. For JSX use `<Money>` and `<LocalTime>`; these are for plain strings
 * (labels, toasts, error messages, contracts).
 */
import { formatCents, wholeDollars } from "./money";

export { formatCents, wholeDollars };
export { dateFormat, shortMonths } from "./dates";

/** Whole-dollar money text: "$1,234" — for figures the game rounds anyway. */
export const formatDollars = (cents: number): string => formatCents(wholeDollars(cents));

const counts = new Intl.NumberFormat("en-US");
/** A count with thousands separators: 1234 → "1,234". */
export const formatCount = (n: number | bigint): string => counts.format(n);

/** Basis points as a percentage: 1500 → "15%", 650 → "6.5%", 1234 → "12.34%". */
export const formatBp = (bp: number): string => `${Number((bp / 100).toFixed(2))}%`;
