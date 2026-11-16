/**
 * Company time: reporting periods (months, pay weeks) follow the owner's clock,
 * Europe/London, including BST (docs/research/04). Instants stay in UTC; only
 * period boundaries are computed in this zone.
 */
export const COMPANY_TIMEZONE = "Europe/London";

/** Offset of `timeZone` from UTC at `date`, in minutes (BST → +60). */
export function tzOffsetMinutes(date: Date, timeZone = COMPANY_TIMEZONE): number {
  const name = new Intl.DateTimeFormat("en-GB", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(date)
    .find((p) => p.type === "timeZoneName")?.value;
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name ?? "");
  if (!m) return 0;
  const minutes = Number(m[2]) * 60 + Number(m[3] ?? 0);
  return m[1] === "-" ? -minutes : minutes;
}

/** Calendar parts of `date` as seen in `timeZone`. */
export function zonedParts(date: Date, timeZone = COMPANY_TIMEZONE) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "numeric", day: "numeric" })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

/** The UTC instant of local midnight on the given calendar day in `timeZone`. */
export function zonedMidnight(year: number, month: number, day: number, timeZone = COMPANY_TIMEZONE): Date {
  const guess = new Date(Date.UTC(year, month - 1, day));
  // Two passes handle days where the offset itself changes (DST transitions).
  const first = new Date(guess.getTime() - tzOffsetMinutes(guess, timeZone) * 60_000);
  return new Date(guess.getTime() - tzOffsetMinutes(first, timeZone) * 60_000);
}

/** Upper bound for open-ended periods; within PostgreSQL's timestamptz range (unlike JS's max Date). */
export const END_OF_TIME = new Date("9999-12-31T00:00:00Z");

export type Period = { key: string; label: string; from: Date; to: Date };

export function monthPeriod(year: number, month: number): Period {
  const from = zonedMidnight(year, month, 1);
  const to = month === 12 ? zonedMidnight(year + 1, 1, 1) : zonedMidnight(year, month + 1, 1);
  const label = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(Date.UTC(year, month - 1, 1));
  return { key: `${year}-${String(month).padStart(2, "0")}`, label, from, to };
}

/** Standard reporting periods relative to `now`. */
export function reportingPeriods(now = new Date()): Period[] {
  const { year, month } = zonedParts(now);
  const thisMonth = monthPeriod(year, month);
  const lastMonth = month === 1 ? monthPeriod(year - 1, 12) : monthPeriod(year, month - 1);
  return [
    { ...thisMonth, key: "this-month", label: `This month (${thisMonth.label})` },
    { ...lastMonth, key: "last-month", label: `Last month (${lastMonth.label})` },
    { key: "ytd", label: `Year to date (${year})`, from: zonedMidnight(year, 1, 1), to: END_OF_TIME },
    { key: "all", label: "All time", from: new Date(0), to: END_OF_TIME },
  ];
}
