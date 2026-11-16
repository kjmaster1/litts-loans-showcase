import type { LoanCard } from "./parse-cards";

/**
 * Matches pasted phone cards to known loans (docs/design/LOANS.md §Matching).
 * Pure: the caller supplies candidate loans with what the bank data says
 * about each one.
 */

export type CandidateLoan = {
  id: string;
  borrowerStateId: number;
  principalCents: number;
  openedAt: Date;
  /** Instalment count seen in subscription comments ("…k/N"), if any. */
  observedInstalments: number | null;
  /** Principal received so far ÷ principal. */
  returnedRatio: number;
  /** The game's own comments reached "N/N" (paid up, even if the money looks short — early-repayment bugs). */
  paidUp?: boolean;
  /** Already matched to a card of this paste. */
};

export type CardMatch =
  | { kind: "matched"; card: LoanCard; loanId: string; how: "principal" | "agreement_total" | "instalments" | "only_loan" }
  | { kind: "ambiguous"; card: LoanCard; candidateIds: string[] }
  | { kind: "new"; card: LoanCard; reason: "no_disbursement" }
  | { kind: "ignored"; card: LoanCard; reason: "legacy_mortgage" | "not_business_wallet" | "duplicate_card" };

const LOAN_WALLET = "69811362";

/** Instalment count from a subscription comment ("… 3/10" at the end). */
export function instalmentsFromComment(comment: string): number | null {
  const m = /(\d+)\/(\d+)\s*$/.exec(comment.trim());
  return m ? Number(m[2]) : null;
}

/**
 * True when a subscription comment says the last instalment was paid ("… 8/8").
 * In "Loan Agreement Amount: $600008/8" the amount and k run together, so the
 * loan's own amount (principal, or total repayable in early versions) is
 * stripped first when given.
 */
export function finalInstalment(comment: string, amountsDollars: number[] = []): boolean {
  const text = comment.trim();
  const m = /(\d+)\/(\d+)\s*$/.exec(text);
  if (!m) return false;
  const n = Number(m[2]);
  let digits = m[1];
  if (/Loan Agreement Amount:\s*\$\d+\/\d+\s*$/.test(text)) {
    const prefix = amountsDollars.map(String).find((a) => digits.startsWith(a) && digits.length > a.length);
    if (!prefix) return false;
    digits = digits.slice(prefix.length);
  }
  return n > 0 && Number(digits) === n;
}

/**
 * Why a card with no loan in the bank data can't start a card-only loan (null = it can).
 * Only cards that state the principal ("Loan Agreement Amount", Active/Complete tabs) may:
 * a guessed size makes a record that later can't adopt its disbursement and lingers as a
 * duplicate (2026-10-12 data-quality review).
 */
export function problemForNewLoan(card: LoanCard): string | null {
  if (card.principalCents === null || card.principalCents <= 0) {
    return "This card doesn’t state the loan amount, so it can’t start a new loan. Import the latest bank export, then paste the tab again.";
  }
  return null;
}

export function matchCards(cards: LoanCard[], loans: CandidateLoan[]): CardMatch[] {
  const used = new Set<string>();
  const results: CardMatch[] = [];

  // Cards that state their principal are the most reliable — match them first so
  // their loans are taken before the vaguer Overdue/Default cards choose.
  const order = [...cards].sort((a, b) => Number(b.principalCents !== null) - Number(a.principalCents !== null) || a.index - b.index);
  // The same card twice in one paste (copied overlapping parts of the tab) is one loan, not two.
  const seen = new Set<string>();

  for (const card of order) {
    const text = card.raw.replace(/\s+/g, " ").trim();
    if (seen.has(text)) {
      results.push({ kind: "ignored", card, reason: "duplicate_card" });
      continue;
    }
    seen.add(text);
    if (card.type === "mortgage") {
      results.push({ kind: "ignored", card, reason: "legacy_mortgage" });
      continue;
    }
    if (card.wallet !== LOAN_WALLET) {
      results.push({ kind: "ignored", card, reason: "not_business_wallet" });
      continue;
    }

    const mine = loans.filter((l) => l.borrowerStateId === card.stateId && !used.has(l.id));
    let pool = mine;
    let how: "principal" | "agreement_total" | "instalments" | "only_loan" = "only_loan";

    if (card.principalCents !== null) {
      pool = mine.filter((l) => l.principalCents === card.principalCents);
      how = "principal";
      if (pool.length === 0 && card.brokerRatePct !== null) {
        // Early game versions (Jan–Apr 2026) showed the total repayable,
        // principal × (1 + broker rate), as the "Loan Agreement Amount".
        const implied = card.principalCents / (1 + card.brokerRatePct / 100);
        pool = mine.filter((l) => Math.abs(l.principalCents - implied) <= 1_000);
        how = "agreement_total";
      }
    } else if (card.instalments !== null) {
      const byN = mine.filter((l) => l.observedInstalments === card.instalments);
      if (byN.length > 0) {
        pool = byN;
        how = "instalments";
      }
    }

    const finished = card.completed !== null && card.instalments !== null && card.completed >= card.instalments;
    if (pool.length > 1) {
      // A completed card belongs to a repaid loan; a live one to a loan still open.
      const done = (l: CandidateLoan) => l.paidUp === true || l.returnedRatio >= 0.97;
      const fitting = pool.filter((l) => (finished ? done(l) : !done(l)));
      if (fitting.length > 0) pool = fitting;
    }
    if (pool.length > 1 && card.principalCents !== null) {
      // Several same-size loans to one person: oldest for a finished card, newest for a live one.
      pool = [pool.reduce((a, b) => ((finished ? a.openedAt < b.openedAt : a.openedAt > b.openedAt) ? a : b))];
    }

    if (pool.length === 1) {
      used.add(pool[0].id);
      results.push({ kind: "matched", card, loanId: pool[0].id, how });
    } else if (pool.length === 0) {
      results.push({ kind: "new", card, reason: "no_disbursement" });
    } else {
      results.push({ kind: "ambiguous", card, candidateIds: pool.map((l) => l.id) });
    }
  }

  return results.sort((a, b) => a.card.index - b.card.index);
}
