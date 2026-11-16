import { dollarsToCents, wholeDollars } from "@/lib/money";

/**
 * Parser for text copied from the phone's "Business Subscriptions" tabs
 * (Active / Overdue / Default / Complete). Format: docs/research/01 §4.
 *
 * Cards have a variable number of lines depending on state, so this is a
 * tolerant line scanner: a card starts at a "$x.xx" line followed by an
 * 8-digit wallet and a State ID; every other line is recognised by pattern.
 * Unknown lines are kept as warnings rather than failing the whole paste.
 * The game's own typos ("missed to many missed payments! {{comment}}") are
 * accepted as-is.
 */

export type LoanCard = {
  /** 0-based position in the paste. */
  index: number;
  raw: string;
  headerAmountCents: number;
  wallet: string;
  stateId: number;
  type: "loan" | "mortgage";
  stateRatePct: number | null;
  brokerRatePct: number | null;
  originalTotalRatePct: number | null;
  currentTotalRatePct: number | null;
  /** Penalty added to the rate for missed payments (e.g. +4.00). */
  rateDeltaPct: number;
  missedPayments: number | null;
  firstMissedAt: Date | null;
  /** "$313) remaining" — absent on some cards; may carry float noise in the game. */
  remainingCents: number | null;
  completed: number | null;
  instalments: number | null;
  nextPaymentIn: { value: number; unit: "minutes" | "hours" | "days" } | null;
  periodDays: number | null;
  /** "Loan Agreement Amount: $P" — Active/Complete cards only. */
  principalCents: number | null;
  mortgageAddress: string | null;
  status: "ok" | "overdue" | "defaulted" | "sanctioned";
  /** The overdue/default/sanction line exactly as shown. */
  statusText: string | null;
  action: "move_to_overdue" | "repay_in_full" | null;
  warnings: string[];
};

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

const HEADER = /^\$[\d,]+(?:\.\d+)?$/;
const WALLET = /^\d{6,10}$/;
const STATE_ID = /^\d{1,7}$/;

const money = (s: string) => dollarsToCents(Number(s.replace(/[$,\s]/g, "")));

/**
 * "9 April 2026 - 05:44:25 PM (GMT+1)" or "October 9, 2026 - 12:03:01 AM (GMT+1)"
 * → UTC instant. Returns null if unrecognised.
 */
export function parseGameDate(text: string): Date | null {
  const m =
    /(?:(\d{1,2})\s+([A-Za-z]+)|([A-Za-z]+)\s+(\d{1,2}),)\s+(\d{4})\s*-\s*(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)\s*\((?:GMT|UTC)([+-]\d{1,2})(?::?(\d{2}))?\)/i.exec(text);
  if (!m) return null;
  const day = Number(m[1] ?? m[4]);
  const month = MONTHS.indexOf((m[2] ?? m[3]).toLowerCase());
  if (month < 0) return null;
  let hour = Number(m[6]) % 12;
  if (m[9].toUpperCase() === "PM") hour += 12;
  const offsetMinutes = Number(m[10]) * 60 + Math.sign(Number(m[10]) || 1) * Number(m[11] ?? 0);
  const utc = Date.UTC(Number(m[5]), month, day, hour, Number(m[7]), Number(m[8])) - offsetMinutes * 60_000;
  return new Date(utc);
}

function isCardStart(lines: string[], i: number) {
  return HEADER.test(lines[i]) && WALLET.test(lines[i + 1] ?? "") && STATE_ID.test(lines[i + 2] ?? "");
}

export function parseCards(text: string): { cards: LoanCard[]; ignoredLines: string[] } {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const starts: number[] = [];
  for (let i = 0; i < lines.length; i++) if (isCardStart(lines, i)) starts.push(i);
  const ignoredLines = lines.slice(0, starts[0] ?? lines.length);

  const cards = starts.map((start, index) => {
    const end = starts[index + 1] ?? lines.length;
    return parseCard(lines.slice(start, end), index);
  });
  return { cards, ignoredLines };
}

function parseCard(lines: string[], index: number): LoanCard {
  const card: LoanCard = {
    index,
    raw: lines.join("\n"),
    headerAmountCents: money(lines[0]),
    wallet: lines[1],
    stateId: Number(lines[2]),
    type: "loan",
    stateRatePct: null,
    brokerRatePct: null,
    originalTotalRatePct: null,
    currentTotalRatePct: null,
    rateDeltaPct: 0,
    missedPayments: null,
    firstMissedAt: null,
    remainingCents: null,
    completed: null,
    instalments: null,
    nextPaymentIn: null,
    periodDays: null,
    principalCents: null,
    mortgageAddress: null,
    status: "ok",
    statusText: null,
    action: null,
    warnings: [],
  };

  for (const line of lines.slice(3)) {
    let m: RegExpExecArray | null;
    if ((m = /^TYPE\s+(loan|mortgage)$/i.exec(line))) card.type = m[1].toLowerCase() as "loan" | "mortgage";
    else if ((m = /^State interest rate\s+([\d.]+)\s*%$/i.exec(line))) card.stateRatePct = Number(m[1]);
    else if ((m = /^Broker interest rate\s+([\d.]+)\s*%$/i.exec(line))) card.brokerRatePct = Number(m[1]);
    else if ((m = /^Original total interest rate\s+([\d.]+)\s*%$/i.exec(line))) card.originalTotalRatePct = Number(m[1]);
    else if ((m = /^Current total interest rate\s+([\d.]+)\s*%\s*\(([+-]?[\d.]+)%\)$/i.exec(line))) {
      card.currentTotalRatePct = Number(m[1]);
      card.rateDeltaPct = Number(m[2]);
    } else if ((m = /^Missed payment amounts\s+(\d+)$/i.exec(line))) card.missedPayments = Number(m[1]);
    else if ((m = /^First missed payment:\s*(.+)$/i.exec(line))) {
      card.firstMissedAt = parseGameDate(m[1]);
      if (!card.firstMissedAt) card.warnings.push(`Unrecognised date: ${m[1]}`);
    } else if ((m = /^\$([\d,.]+)\) remaining$/i.exec(line))) card.remainingCents = wholeDollars(Math.round(Number(m[1].replace(/,/g, "")) * 100));
    else if ((m = /^(\d+)\s*\/\s*(\d+)\s*complete$/i.exec(line))) {
      card.completed = Number(m[1]);
      card.instalments = Number(m[2]);
    } else if ((m = /^Next payment:\s*in\s+(\d+)\s+(minute|hour|day)s?$/i.exec(line))) {
      card.nextPaymentIn = { value: Number(m[1]), unit: `${m[2].toLowerCase()}s` as "minutes" | "hours" | "days" };
    } else if ((m = /^every\s+(\d+)\s+days?$/i.exec(line))) card.periodDays = Number(m[1]);
    else if ((m = /^Loan Agreement Amount:\s*\$([\d,]+)$/i.exec(line))) card.principalCents = money(m[1]);
    else if ((m = /^Mortgage Agreement:\s*(.+),\s*Amount:\s*\$([\d,]+)$/i.exec(line))) {
      card.mortgageAddress = m[1];
      card.principalCents = money(m[2]);
    } else if (/^SANCTIONED:/i.test(line)) {
      card.status = "sanctioned";
      card.statusText = line;
    } else if (/^DEFAULTED:/i.test(line)) {
      card.status = "defaulted";
      card.statusText = line;
    } else if (/^(DEACTIVATED:\s*)?OVERDUE:/i.test(line)) {
      card.status = "overdue";
      card.statusText = line;
    } else if (/^MOVE TO OVERDUE$/i.test(line)) card.action = "move_to_overdue";
    else if (/^Re-?Pay In Full$/i.test(line)) card.action = "repay_in_full";
    else card.warnings.push(`Unrecognised line: ${line}`);
  }

  if (card.instalments === null) card.warnings.push("No k/N progress line.");
  if (card.stateRatePct !== null && card.brokerRatePct !== null && card.stateRatePct > card.brokerRatePct) {
    card.warnings.push(
      `State rate ${card.stateRatePct}% is higher than the broker rate ${card.brokerRatePct}%, so Litt's loses money on this loan. Were they entered the wrong way round?`,
    );
  }
  return card;
}
