/**
 * Commission paid by hand before the scheme started (docs/research/10). The
 * old payments list what they paid for:
 *   "Employee Pay: Commission Pay: Frankie Elsworth  Sep 24, 2026 · interest  $816   …"
 * Each item is a borrower, the day of the receipt, its kind and the commission
 * paid. Pure.
 */

export type PaidItem = { name: string; year: number; month: number; day: number; kind: "interest" | "early_interest"; amountCents: number };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ITEM = /([A-Z][A-Za-z'’-]*(?:\s+[A-Z][A-Za-z'’-]*)*)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),\s*(\d{4})\s*·\s*(early interest|interest)\s+\$([\d,]+(?:\.\d+)?)/g;

export function parseCommissionItems(comment: string): PaidItem[] {
  // Some exports carry the middle dot as "Â·" (UTF-8 read as Latin-1).
  const text = comment.replace(/^.*?Commission Pay:\s*/i, " ").replace(/Â·/g, "·");
  const items: PaidItem[] = [];
  for (const m of text.matchAll(ITEM)) {
    items.push({
      name: m[1].replace(/\s+/g, " ").trim(),
      year: Number(m[4]),
      month: MONTHS.indexOf(m[2]) + 1,
      day: Number(m[3]),
      kind: m[5] === "early interest" ? "early_interest" : "interest",
      amountCents: Math.round(Number(m[6].replace(/,/g, "")) * 100),
    });
  }
  return items;
}

export type InterestReceiptLike = {
  id: string;
  borrowerName: string | null;
  /** UK calendar date of the receipt. */
  year: number;
  month: number;
  day: number;
  kind: "interest" | "early_interest";
  /** What 50% of (amount - tax) comes to. */
  commissionCents: number;
};

const dayNumber = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / 86_400_000;
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Which receipts an old payment already covered: same borrower within a day
 * (the export and the game can disagree on the date). The amount and kind only
 * break ties - how much was paid was the payer's call. Each listed item covers
 * at most one receipt. Returns receipt id -> the item that paid it.
 */
export function alreadyPaid<T extends PaidItem>(receipts: InterestReceiptLike[], items: T[]): Map<string, T> {
  const paid = new Map<string, T>();
  const byName = new Map<string, T[]>();
  for (const it of items) byName.set(norm(it.name), [...(byName.get(norm(it.name)) ?? []), it]);
  for (const r of receipts) {
    if (!r.borrowerName) continue;
    const left = byName.get(norm(r.borrowerName));
    if (!left?.length) continue;
    const day = dayNumber(r.year, r.month, r.day);
    let best = -1;
    let bestScore = Infinity;
    left.forEach((it, i) => {
      const dd = Math.abs(dayNumber(it.year, it.month, it.day) - day);
      if (dd > 1) return;
      const score = dd * 1e12 + (it.kind === r.kind ? 0 : 1e10) + Math.abs(it.amountCents - r.commissionCents);
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    });
    if (best >= 0) {
      paid.set(r.id, left[best]);
      left.splice(best, 1);
    }
  }
  return paid;
}
