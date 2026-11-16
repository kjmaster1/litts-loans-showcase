/**
 * en-GB short months say "Sept" while every other month has three letters; tables and
 * labels read better with "Sep". Use for any `month: "short"` output.
 */
export const shortMonths = (s: string) => s.replace(/\bSept\b/g, "Sep");

/** en-GB date formatter with three-letter months. */
export function dateFormat(opts: Intl.DateTimeFormatOptions): { format: (d: Date | number) => string } {
  const f = new Intl.DateTimeFormat("en-GB", opts);
  return { format: (d) => shortMonths(f.format(d)) };
}

/**
 * "2026-10-09T21:15" in the browser's own timezone, for a `datetime-local` input (read back with
 * `new Date(value)`). Client-side only: on the server it would use the server's zone.
 */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
