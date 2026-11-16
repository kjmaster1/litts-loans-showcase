import type { LoanCard } from "./parse-cards";

export type LoanStatus = "active" | "overdue" | "defaulted" | "written_off" | "completed";
export type LoanTab = "active" | "overdue" | "default" | "complete";

const TAB_STATUS: Record<LoanTab, LoanStatus> = { active: "active", overdue: "overdue", default: "defaulted", complete: "completed" };

/**
 * Status from the phone tab the card is in — the game is the source of truth.
 * A card in the Active tab can show a missed payment ("OVERDUE: Missed payment
 * 2/8 (1 missed)") and still be Active; the missed count is kept separately.
 * Write-off is the exception: an accounting decision a later paste never undoes.
 */
export function statusFromCard(current: LoanStatus | null, tab: LoanTab): LoanStatus {
  return current === "written_off" ? "written_off" : TAB_STATUS[tab];
}

/** Write-offs become available this many days after a loan defaults (owner decision, research/03; now a setting). */
export const WRITE_OFF_AFTER_DAYS = 28;

/**
 * When a loan is treated as having defaulted: the game defaults on the 3rd
 * missed payment, i.e. two payment periods after the first miss.
 */
export function defaultedAtEstimate(firstMissedAt: Date | null, periodDays: number | null, fallback: Date): Date {
  if (!firstMissedAt) return fallback;
  return new Date(firstMissedAt.getTime() + 2 * (periodDays ?? 7) * 86_400_000);
}

/**
 * When a loan defaulted, from whatever is known (earliest reliable evidence wins):
 * - the card's "First missed payment" date → + 2 periods (the 3rd miss);
 * - otherwise the last regular payment (or the loan's start if none) → + 3 periods,
 *   since the next three payments were missed (old-version cards carry no date).
 * Weekly unless the period is known. Never later than `now`.
 */
export function estimateDefaultedAt(input: { firstMissedAt: Date | null; periodDays: number | null; lastPaidAt: Date | null; openedAt: Date | null; now: Date }): Date {
  const period = (input.periodDays ?? 7) * 86_400_000;
  let at: Date | null = null;
  if (input.firstMissedAt) at = new Date(input.firstMissedAt.getTime() + 2 * period);
  else {
    const base = input.lastPaidAt ?? input.openedAt;
    if (base) at = new Date(base.getTime() + 3 * period);
  }
  return at && at < input.now ? at : input.now;
}

export function writeOffEligibleAt(firstDefaultAt: Date, afterDays: number = WRITE_OFF_AFTER_DAYS): Date {
  return new Date(firstDefaultAt.getTime() + afterDays * 86_400_000);
}

const UNIT_MS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 } as const;

/**
 * A tab pasted again with exactly the text of its previous paste, although enough time has passed for a countdown on
 * it ("in 23 hours") to have changed: an old copy, or a phone that didn't refresh (13 Oct 2026: the same text pasted
 * 1 h 45 m apart). Returns the previous paste's time, or null.
 */
export function staleRepaste(
  cards: Pick<LoanCard, "raw" | "nextPaymentIn">[],
  previous: { capturedAt: Date; raws: string[] } | null,
  now: Date,
): Date | null {
  if (!previous || previous.raws.length !== cards.length || cards.some((c, i) => c.raw !== previous.raws[i])) return null;
  const units = cards.flatMap((c) => (c.nextPaymentIn ? [UNIT_MS[c.nextPaymentIn.unit]] : []));
  if (units.length === 0) return null;
  return now.getTime() - previous.capturedAt.getTime() >= Math.min(...units) ? previous.capturedAt : null;
}

/** "Next payment: in 2 hours" relative to when the card was pasted. */
export function nextDueFrom(card: Pick<LoanCard, "nextPaymentIn">, capturedAt: Date): Date | null {
  if (!card.nextPaymentIn) return null;
  return new Date(capturedAt.getTime() + card.nextPaymentIn.value * UNIT_MS[card.nextPaymentIn.unit]);
}
