/**
 * Recoveries on bad loans (owner, 2026-10-10). Money that comes back after a loan
 * has defaulted — settlement payments, a seizure, a collateral sale — is filed in a
 * recovery category (account 4300). When the bank comment names the borrower, the
 * row is linked to their loan (role `recovery`) so the loan's record, net result
 * and the recovery rate in expected losses all see it. Pure.
 *
 * Only an unambiguous match links: exactly one borrower named, and exactly one of
 * their bad loans was running by then — or, if several, exactly one had defaulted by
 * then (default dates on old cards are estimates, so they only break ties). Anything
 * else is left for a person to sort out.
 */

/**
 * Refunds of game errors (audit F3): money Litt's gave back to a borrower the game
 * overcharged. Linked to the borrower's latest loan opened before the refund — found by
 * the wallet it was paid to — so that loan's net result is right.
 */
export type RefundRow = { id: string; occurredAt: Date; targetWallet: string | null };
export type WalletLoan = { id: string; openedAt: Date | null; wallets: string[] };

export function matchRefunds(rows: RefundRow[], loans: WalletLoan[]): { txId: string; loanId: string }[] {
  const out: { txId: string; loanId: string }[] = [];
  for (const r of rows) {
    if (!r.targetWallet) continue;
    const theirs = loans
      .filter((l) => l.openedAt && l.openedAt <= r.occurredAt && l.wallets.includes(r.targetWallet!))
      .sort((a, b) => b.openedAt!.getTime() - a.openedAt!.getTime());
    if (theirs[0]) out.push({ txId: r.id, loanId: theirs[0].id });
  }
  return out;
}

export const RECOVERY_CATEGORIES = ["recovery.settlement", "recovery.seizure", "collateral_sale"] as const;

export type RecoveryRow = { id: string; occurredAt: Date; comment: string };
export type BadLoan = { id: string; borrowerName: string | null; openedAt: Date | null; firstDefaultAt: Date | null };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function matchRecoveries(rows: RecoveryRow[], loans: BadLoan[]): { txId: string; loanId: string }[] {
  const named = loans.filter((l): l is BadLoan & { borrowerName: string; openedAt: Date } => Boolean(l.borrowerName && norm(l.borrowerName).includes(" ") && l.openedAt));
  const names = [...new Set(named.map((l) => norm(l.borrowerName)))];
  const out: { txId: string; loanId: string }[] = [];
  for (const r of rows) {
    const text = ` ${norm(r.comment)} `;
    const hits = names.filter((n) => text.includes(` ${n} `));
    if (hits.length !== 1) continue;
    const running = named.filter((l) => norm(l.borrowerName) === hits[0] && l.openedAt <= r.occurredAt);
    const candidates = running.length > 1 ? running.filter((l) => l.firstDefaultAt && l.firstDefaultAt <= r.occurredAt) : running;
    if (candidates.length === 1) out.push({ txId: r.id, loanId: candidates[0].id });
  }
  return out;
}
