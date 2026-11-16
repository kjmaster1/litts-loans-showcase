import { wholeDollars } from "@/lib/money";
import type { LinkRole } from "./link";

/**
 * Contract vs actual for one loan (docs/design/LOANS.md). Pure.
 *
 * Contract (game rules, research/02): N equal principal instalments every
 * `periodDays`; each carries interest P/N·b; the borrower pays P/N·(1+b); the
 * State keeps s of each principal instalment, so the company receives
 * P/N·(1−s). Interest is flat and never compounds.
 *
 * Game quirks (bugs we record, never correct — research/02, research/14):
 * - early repayments can be overcharged interest, or charged interest with no principal;
 * - the final instalment is never charged its interest (32 of 33 on-schedule loans);
 * - payoff never quite clears, leaving a closing difference.
 */

export type LoanTerms = {
  principalCents: number;
  instalments: number;
  periodDays: number;
  /** Broker rate as a fraction (0.15 = 15%). */
  brokerRate: number;
  /** State rate as a fraction (0.01 = 1%). */
  stateRate: number;
  openedAt: Date;
};

export type LinkedPayment = { txId: string; role: LinkRole; amountCents: number; occurredAt: Date };

export type ScheduleRow = {
  number: number;
  dueAt: Date;
  principalCents: number;
  /** What the agreement says. */
  interestCents: number;
  borrowerPaysCents: number;
  /** False for the final instalment: the game never charges its interest. */
  interestCharged: boolean;
};

/**
 * `game`: a quirk of the game's loan system (recorded, not corrected).
 * `setup`: how the loan was set up in the game (worth checking with the officer).
 */
export type LoanFlag =
  | { kind: "early_overcharge"; source: "game"; cents: number; detail: string }
  | { kind: "interest_without_principal"; source: "game"; cents: number; detail: string }
  | { kind: "overpaid"; source: "game"; cents: number; detail: string }
  | { kind: "final_interest_not_charged"; source: "game"; cents: number; detail: string }
  | { kind: "loss_making_rates"; source: "setup"; cents: number; detail: string };

/** The game never charges interest on a loan's final instalment. */
export const FINAL_INSTALMENT_INTEREST_CHARGED = false;

export type LoanAnalysis = {
  schedule: ScheduleRow[];
  contractInterestCents: number;
  principalReceivedCents: number;
  interestReceivedCents: number;
  /** State's share of principal receipts (an expense to the company). */
  levyCents: number;
  /** Levy per principal receipt, for posting. */
  levyByTx: Map<string, number>;
  /** principal − principal received − levy (negative = overpaid). Principal received leaves out overdue penalties. */
  outstandingCents: number;
  /** The game's overdue penalties inside principal instalments (`penaltyFor`), booked as late fees. */
  penaltyCents: number;
  penaltyByTx: Map<string, number>;
  /**
   * Instalments paid, on time or late — what the phone's "n/N complete" counts. A "Late Finance
   * Repayment" pays a missed instalment; an early repayment doesn't count (the game keeps the number
   * of instalments and shrinks them).
   */
  instalmentsPaid: number;
  /** When the game wants each instalment (`gameDueDates`); the contract's dates are on `schedule`. */
  gameDueAt: Date[];
  flags: LoanFlag[];
};

const DAY_MS = 86_400_000;
const PAIR_MS = 2_000;
const PRINCIPAL: ReadonlySet<LinkRole> = new Set(["principal", "early_principal", "late_principal"]);

const pctText = (r: number) => `${Math.round(r * 10_000) / 100}%`;

export function contractSchedule(t: LoanTerms): ScheduleRow[] {
  const rows: ScheduleRow[] = [];
  let allocated = 0;
  for (let n = 1; n <= t.instalments; n++) {
    // Whole dollars like the game; the last instalment takes the remainder so they sum to the principal.
    const principal = n === t.instalments ? t.principalCents - allocated : wholeDollars(t.principalCents / t.instalments);
    allocated += principal;
    const interest = wholeDollars(principal * t.brokerRate);
    rows.push({
      number: n,
      dueAt: new Date(t.openedAt.getTime() + n * t.periodDays * DAY_MS),
      principalCents: principal,
      interestCents: interest,
      borrowerPaysCents: principal + interest,
      interestCharged: n < t.instalments || FINAL_INSTALMENT_INTEREST_CHARGED,
    });
  }
  return rows;
}

/**
 * State share taken out of a principal receipt, given what the company actually received.
 * Deliberately floating point, like the game's own arithmetic (owner review 2026-10-11): this
 * is what the State actually deducts, and the sync trues up posted levies to this formula —
 * making it "exact" could move a half-dollar case by $1 and post corrections to the books.
 *
 * Early repayments have none (owner, 2026-10-13). A payment X splits into X(1−b−s) principal,
 * Xb interest and Xs to the State, and the game takes only X(1−b−s) off the loan: the State's
 * share is on top, paid by the borrower, not taken from Litt's principal. Onyx Greystone's card
 * says $156 left; counting a levy on her early repayments made it −$156.
 */
export function levyFor(role: LinkRole, receivedCents: number, t: Pick<LoanTerms, "brokerRate" | "stateRate">): number {
  const s = t.stateRate;
  if (s <= 0 || role === "early_principal" || !PRINCIPAL.has(role)) return 0;
  return wholeDollars((receivedCents * s) / (1 - s));
}

/**
 * When the game wants each instalment. It doesn't keep the contract's dates: each instalment falls
 * due one period after the previous one was paid (on time or late), so the dates drift a little every
 * week (the game charges some minutes after the due time) and move on by days after a late payment
 * (Ridley Thornbury, Oct 2026: paid late on 12 Oct 13:18, next due 19 Oct, not the contract's 17 Oct).
 * An instalment not yet paid is followed one period after its own due date.
 */
export function gameDueDates(t: Pick<LoanTerms, "openedAt" | "periodDays" | "instalments">, instalmentPaidAt: Date[]): Date[] {
  const period = t.periodDays * DAY_MS;
  const paid = [...instalmentPaidAt].sort((a, b) => a.getTime() - b.getTime());
  const due: Date[] = [];
  for (let i = 0; i < t.instalments; i++) {
    const from = i === 0 ? t.openedAt : (paid[i - 1] ?? due[i - 1]);
    due.push(new Date(from.getTime() + period));
  }
  return due;
}

/**
 * When the next instalment is due, as the app shows it. The game's own due date from the bank (`gameDueDates`)
 * whenever the bank has seen at least the instalments the phone counted: it is exact, and it moves as soon as a
 * payment is imported. The card's estimate only when the bank is behind the phone (its export not imported yet).
 * The card says "in 23 hours" relative to when the text was copied, not pasted: a copy pasted again later is late
 * by the time in between (13 Oct 2026: the same text pasted 1 h 45 m apart put three loans' next payment 1–1.5 h
 * after the game's).
 */
export function nextPaymentDue(
  t: Pick<LoanTerms, "openedAt" | "periodDays" | "instalments">,
  instalmentPaidAt: Date[],
  card: { completed: number | null; estimate: Date | null },
): Date | null {
  const paid = instalmentPaidAt.length;
  if (card.completed !== null && card.completed > paid) return card.estimate;
  return paid < t.instalments ? gameDueDates(t, instalmentPaidAt)[paid] : null;
}

/** The roles that pay one instalment each (the phone's count). */
export const INSTALMENT_ROLES: ReadonlySet<LinkRole> = new Set(["principal", "late_principal"]);

/**
 * The game's overdue penalty inside a principal instalment (audit F5; owner 2026-10-13: booked as a late fee, not
 * principal). After a missed payment the game charges 2% more on both parts of every later instalment, compounding
 * per missed payment (Winter Holloway: $4,950 → $5,049; Ridley Thornbury: $4,538 → $4,629 → $4,722). Found from the money,
 * not the comment: a regular or late principal receipt that is the contract's receipt × 1.02^k. Anything else —
 * rounding, an instalment shrunk by an early repayment — carries none.
 */
export function penaltyFor(role: LinkRole, receivedCents: number, t: Pick<LoanTerms, "principalCents" | "instalments" | "stateRate">): number {
  if (!INSTALMENT_ROLES.has(role) || t.instalments <= 0) return 0;
  // The game works in floating point per instalment and rounds what moves; the last takes the remainder.
  const per = t.principalCents / t.instalments;
  const last = t.principalCents - wholeDollars(per) * (t.instalments - 1);
  for (const expected of new Set([wholeDollars(per * (1 - t.stateRate)), wholeDollars(last * (1 - t.stateRate))])) {
    if (expected <= 0 || receivedCents <= expected) continue;
    const ratio = receivedCents / expected;
    for (let k = 1; k <= 6; k++) if (Math.abs(ratio - 1.02 ** k) <= 0.0035) return receivedCents - expected;
  }
  return 0;
}

export function analyseLoan(t: LoanTerms, payments: LinkedPayment[]): LoanAnalysis {
  const schedule = contractSchedule(t);
  const levyByTx = new Map<string, number>();
  let principalReceived = 0;
  let interestReceived = 0;
  let instalments = 0;
  let regularInterest = 0;
  const penaltyByTx = new Map<string, number>();

  for (const p of payments) {
    if (PRINCIPAL.has(p.role)) {
      const penalty = penaltyFor(p.role, p.amountCents, t);
      if (penalty > 0) penaltyByTx.set(p.txId, penalty);
      principalReceived += p.amountCents - penalty;
      const levy = levyFor(p.role, p.amountCents - penalty, t);
      if (levy > 0) levyByTx.set(p.txId, levy);
      if (INSTALMENT_ROLES.has(p.role)) instalments++;
    } else if (p.role === "interest" || p.role === "early_interest" || p.role === "late_fee") {
      interestReceived += p.amountCents;
      if (p.role === "interest") regularInterest++;
    }
  }
  const levy = [...levyByTx.values()].reduce((s, v) => s + v, 0);
  const flags: LoanFlag[] = [];

  // Early repayments: pair each interest row with its principal row (same second ± 2 s).
  const earlyP = payments.filter((p) => p.role === "early_principal");
  const usedP = new Set<string>();
  let overcharge = 0;
  let overchargeCount = 0;
  let orphan = 0;
  let orphanCount = 0;
  for (const i of payments.filter((p) => p.role === "early_interest")) {
    const partner = earlyP.find((p) => !usedP.has(p.txId) && Math.abs(p.occurredAt.getTime() - i.occurredAt.getTime()) <= PAIR_MS);
    if (!partner) {
      orphan += i.amountCents;
      orphanCount++;
      continue;
    }
    usedP.add(partner.txId);
    // Contract: repaying principal early costs at most its own flat interest.
    const fair = Math.round(partner.amountCents * t.brokerRate);
    if (i.amountCents > fair + 100) {
      overcharge += i.amountCents - fair;
      overchargeCount++;
    }
  }
  if (overcharge > 0) {
    flags.push({
      kind: "early_overcharge",
      source: "game",
      cents: overcharge,
      detail: `${overchargeCount} early repayment(s) charged more interest than the ${Math.round(t.brokerRate * 100)}% contract rate`,
    });
  }
  if (orphan > 0) {
    flags.push({ kind: "interest_without_principal", source: "game", cents: orphan, detail: `${orphanCount} early-interest charge(s) with no principal credited` });
  }

  const outstanding = t.principalCents - principalReceived - levy;
  // Tolerance: the game rounds each instalment to whole dollars.
  if (outstanding < -Math.max(500, t.instalments * 100)) {
    flags.push({ kind: "overpaid", source: "game", cents: -outstanding, detail: "More principal was collected than was lent" });
  }
  // Every instalment paid, but one interest payment short: the final one.
  if (instalments === t.instalments && regularInterest === t.instalments - 1 && schedule.at(-1)!.interestCents > 0) {
    flags.push({ kind: "final_interest_not_charged", source: "game", cents: schedule.at(-1)!.interestCents, detail: "The game didn't charge interest on the final instalment" });
  }
  if (t.stateRate > t.brokerRate) {
    flags.push({
      kind: "loss_making_rates",
      source: "setup",
      cents: wholeDollars(t.principalCents * (t.stateRate - t.brokerRate)),
      detail: `The State's rate (${pctText(t.stateRate)}) is higher than the broker rate (${pctText(t.brokerRate)}), so Litt's loses money on this loan. Were they entered the wrong way round in the game?`,
    });
  }

  return {
    schedule,
    contractInterestCents: schedule.reduce((s, r) => s + r.interestCents, 0),
    principalReceivedCents: principalReceived,
    interestReceivedCents: interestReceived,
    levyCents: levy,
    levyByTx,
    outstandingCents: outstanding,
    penaltyCents: [...penaltyByTx.values()].reduce((s, v) => s + v, 0),
    penaltyByTx,
    instalmentsPaid: instalments,
    gameDueAt: gameDueDates(t, payments.filter((p) => INSTALMENT_ROLES.has(p.role)).map((p) => p.occurredAt)),
    flags,
  };
}
