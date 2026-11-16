/**
 * The 2025–26 manual loans, one by one (audit F7, owner 2026-10-10). Their bank rows
 * carry no IDs, only staff-typed comments, so they're grouped by rules:
 *
 * 1. Payouts in date order are loans #1, #2, … (every numbered payout agrees).
 * 2. A repayment names its loan: "Loan #N", "Loan N", or "#N |" right after "Charge".
 * 3. A typo is overruled by the wallet: if the money came from the payout wallet of
 *    other loans (and not of the named one), it's the one whose number is closest to
 *    the typed number ("Loan #21" from Hollis Everhart's wallet is her #22).
 * 4. No number: the loan last paid out to that wallet before the repayment.
 * 5. Anything still unplaced uses the caller's explicit overrides (comment pattern →
 *    loan number), else it's reported — nothing is guessed silently.
 *
 * Each loan's result is what came back less what was lent (gross; the tax was booked
 * row by row), recognised on the date of its last row. Pure.
 */

export type LegacyRow = { id: string; occurredAt: Date; direction: "in" | "out"; amountCents: number; comment: string; sourceWallet: string | null; targetWallet: string | null };
export type LegacyLoan = { number: number; label: string; rows: LegacyRow[]; resultCents: number; closedAt: Date };

const named = (comment: string): number | null => {
  const m = /\bLoan\s*#?\s*(\d{1,3})\b/i.exec(comment) ?? /^(?:Charge:?\s*)+#(\d{1,3})\b/i.exec(comment.trim());
  return m ? Number(m[1]) : null;
};

export function groupLegacyLoans(rows: LegacyRow[], overrides: { pattern: RegExp; loan: number }[] = []): { loans: LegacyLoan[]; unplaced: LegacyRow[] } {
  const sorted = [...rows].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  const payouts = sorted.filter((r) => r.direction === "out");
  const byNumber = new Map<number, LegacyRow[]>();
  payouts.forEach((p, i) => byNumber.set(i + 1, [p]));
  const walletOf = (n: number) => byNumber.get(n)?.[0].targetWallet ?? null;
  const unplaced: LegacyRow[] = [];

  for (const r of sorted.filter((x) => x.direction === "in")) {
    let n = named(r.comment);
    if (n !== null && !byNumber.has(n)) n = null;
    if (n !== null && r.sourceWallet && walletOf(n) !== r.sourceWallet) {
      // A typo'd number: the wallet belongs to other loans paid out before this — take the nearest number.
      const others = payouts.map((p, i) => ({ p, n: i + 1 })).filter((x) => x.p.targetWallet === r.sourceWallet && x.p.occurredAt <= r.occurredAt);
      if (others.length && !others.some((o) => o.n === n)) {
        const typed = n;
        n = others.reduce((best, o) => (Math.abs(o.n - typed) < Math.abs(best.n - typed) || (Math.abs(o.n - typed) === Math.abs(best.n - typed) && o.n > best.n) ? o : best)).n;
      }
    }
    if (n === null && r.sourceWallet) {
      const last = payouts.map((p, i) => ({ p, n: i + 1 })).filter((x) => x.p.targetWallet === r.sourceWallet && x.p.occurredAt <= r.occurredAt).at(-1);
      if (last) n = last.n;
    }
    if (n === null) n = overrides.find((o) => o.pattern.test(r.comment))?.loan ?? null;
    if (n === null || !byNumber.has(n)) {
      unplaced.push(r);
      continue;
    }
    byNumber.get(n)!.push(r);
  }

  const loans = [...byNumber].map(([number, list]) => ({
    number,
    label: list[0].comment.replace(/^Employee Pay:\s*/i, "").slice(0, 80),
    rows: list,
    resultCents: list.reduce((s, r) => s + (r.direction === "in" ? r.amountCents : -r.amountCents), 0),
    closedAt: list.reduce((d, r) => (r.occurredAt > d ? r.occurredAt : d), list[0].occurredAt),
  }));
  return { loans, unplaced };
}
