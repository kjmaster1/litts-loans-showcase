import { dateFormat, formatCount, formatDollars, wholeDollars } from "@/lib/format";

/**
 * The case sheet sent to the lawyer for a defaulted loan, in the owner's format (2026-11-10; design:
 * docs/superpowers/specs/2026-11-10-legal-case-sheets-design.md). Pure.
 *
 *   Rowan Redgrave - 6661
 *   $8,047 * 5 = 40,235              the latest card's instalment (with the game's +2% penalties) × instalments left
 *   $200 per day in default          the contract's Defaulted Account Fee
 *   Defaulted - July 21st 2026
 *   200 * 16 = $3,200                days from the default to the hand-over (London calendar days)
 *   40,235 + 3,200 = $43,435
 *   Collateral - Ocelot Jackal - G1YBEU4B
 */

export type CaseSheet = {
  borrowerName: string;
  stateId: number;
  instalmentCents: number;
  instalmentsLeft: number;
  claimCents: number;
  feePerDayCents: number;
  /** YYYY-MM-DD, London. */
  defaultedOn: string;
  days: number;
  feeTotalCents: number;
  /** Recoveries between the default and the hand-over, subtracted on the sheet. */
  receivedCents: number;
  totalCents: number;
  collateral: string;
};

const DAY_MS = 86_400_000;

/** Which rule gave a case its default date; `unconfirmed` must be set by hand before the case is ready. */
export type DefaultRule = "override" | "hand_moved" | "game" | "unconfirmed";

/**
 * When the loan defaulted, for the case, and how that was decided. A date set by hand wins. A loan moved to the Default
 * tab by hand (its card shows fewer than 3 missed payments) defaulted on its second missed payment, when the game's
 * manual-default button appears (owner, 2026-11-10) — the stored default date is only when the app first saw it there,
 * so without the card's first missed date it is `unconfirmed`. Otherwise the stored date (the game defaults on the third
 * missed payment).
 */
export function caseDefault(i: { firstDefaultAt: Date | null; firstMissedAt: Date | null; missedPayments: number | null; periodDays: number | null; override: Date | null }): {
  at: Date | null;
  rule: DefaultRule;
} {
  if (i.override) return { at: i.override, rule: "override" };
  if (i.missedPayments !== null && i.missedPayments < 3) {
    return i.firstMissedAt ? { at: new Date(i.firstMissedAt.getTime() + (i.periodDays ?? 7) * DAY_MS), rule: "hand_moved" } : { at: i.firstDefaultAt, rule: "unconfirmed" };
  }
  return { at: i.firstDefaultAt, rule: "game" };
}

const LONDON_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" });

/** The London calendar day of an instant, "YYYY-MM-DD". */
export function londonDay(at: Date): string {
  return LONDON_DAY.format(at);
}

/** Calendar days from one "YYYY-MM-DD" to another. */
export function daysBetween(fromDay: string, toDay: string): number {
  return Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / DAY_MS);
}

const MONTH = dateFormat({ timeZone: "UTC", month: "long" });

function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${suffix}`;
}

/** "2026-07-21" → "July 21st 2026". */
export function ordinalDate(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  return `${MONTH.format(d)} ${ordinal(d.getUTCDate())} ${d.getUTCFullYear()}`;
}

export function buildSheet(i: {
  borrowerName: string;
  stateId: number;
  instalmentCents: number;
  instalments: number;
  completed: number;
  feePerDayCents: number;
  defaultAt: Date;
  asOf: Date;
  receivedCents: number;
  collateral: string;
}): CaseSheet {
  const instalmentCents = wholeDollars(i.instalmentCents);
  const instalmentsLeft = Math.max(0, i.instalments - i.completed);
  const claimCents = instalmentCents * instalmentsLeft;
  const feePerDayCents = wholeDollars(i.feePerDayCents);
  const defaultedOn = londonDay(i.defaultAt);
  const days = Math.max(0, daysBetween(defaultedOn, londonDay(i.asOf)));
  const feeTotalCents = feePerDayCents * days;
  const receivedCents = wholeDollars(Math.max(0, i.receivedCents));
  return {
    borrowerName: i.borrowerName,
    stateId: i.stateId,
    instalmentCents,
    instalmentsLeft,
    claimCents,
    feePerDayCents,
    defaultedOn,
    days,
    feeTotalCents,
    receivedCents,
    totalCents: claimCents + feeTotalCents - receivedCents,
    collateral: i.collateral,
  };
}

const n = (cents: number) => formatCount(cents / 100);

export function sheetText(s: CaseSheet): string {
  const lines = [
    `${s.borrowerName} - ${s.stateId}`,
    `${formatDollars(s.instalmentCents)} * ${s.instalmentsLeft} = ${n(s.claimCents)}`,
    `${formatDollars(s.feePerDayCents)} per day in default`,
    `Defaulted - ${ordinalDate(s.defaultedOn)}`,
    `${n(s.feePerDayCents)} * ${s.days} = ${formatDollars(s.feeTotalCents)}`,
  ];
  if (s.receivedCents > 0) {
    lines.push(`${formatDollars(s.receivedCents)} received since default`);
    lines.push(`${n(s.claimCents)} + ${n(s.feeTotalCents)} - ${n(s.receivedCents)} = ${formatDollars(s.totalCents)}`);
  } else {
    lines.push(`${n(s.claimCents)} + ${n(s.feeTotalCents)} = ${formatDollars(s.totalCents)}`);
  }
  lines.push(`Collateral - ${s.collateral}`);
  return lines.join("\n\n");
}

/**
 * The Pay Employee comment for a case's attorney & filing fee; the game puts "Employee Pay: " in front. The [LEGAL] tag
 * files it as a legal fee whatever the borrower is called (a name like "Bonus" would otherwise match another rule first).
 */
export function feeComment(borrowerName: string, caseNumber: number): string {
  return `[LEGAL] Attorney & Filing Fee - ${borrowerName} Default #LC${caseNumber}`;
}

/** The case number a bank comment refers to ("… #LC12" → 12), or null. */
export function feeReference(comment: string): number | null {
  const m = /#LC(\d{1,9})(?![\w])/i.exec(comment);
  return m ? Number(m[1]) : null;
}
