import { CATEGORIES, type Category, type Direction } from "./categories";

/**
 * Pure posting rules: a classified bank row → balanced journal lines
 * (docs/design/LEDGER.md). The database enforces balance again at commit.
 */
export const CASH = "1000";
export const TAX_EXPENSE = "5200";
export const TAX_MEMO = "9000";
export const TAX_MEMO_CONTRA = "9090";

export type Line = { account: string; debit: number; credit: number; memo?: string };

export type PostableRow = {
  direction: Direction;
  amountCents: number;
  taxCents: number;
  category: Category;
};

const dr = (account: string, amount: number, memo?: string): Line => ({ account, debit: amount, credit: 0, memo });
const cr = (account: string, amount: number, memo?: string): Line => ({ account, debit: 0, credit: amount, memo });

export function postingLines(row: PostableRow): Line[] {
  const { direction, amountCents: a, taxCents: t, category } = row;
  const def = CATEGORIES[category];

  // Monthly tax record: the business never pays it — memo accounts only.
  if (category === "tax.remittance_record") {
    return [dr(TAX_MEMO_CONTRA, a, "Monthly tax record"), cr(TAX_MEMO, a, "Monthly tax record")];
  }

  const lines: Line[] = [];
  if (direction === "in") {
    lines.push(dr(CASH, a - t));
    if (t > 0 && def.tax === "expense") {
      lines.push(dr(TAX_EXPENSE, t, "Tax withheld at source"));
      lines.push(cr(def.account, a));
    } else {
      lines.push(cr(def.account, def.tax === "passthrough" ? a - t : a));
      // A non-pass-through row can only reach here with t = 0.
    }
  } else {
    lines.push(dr(def.account, a));
    lines.push(cr(CASH, a));
  }
  // Only tax withheld from money coming in is the company's to report. Tax on a payment going out
  // was the recipient's: the business paid the full amount, and no State record ever includes it
  // (QA 2026-10-13: a $3,500 flyer invoice taxed $167 had sat in the escrow memo since May 2025).
  if (t > 0 && direction === "in") {
    lines.push(dr(TAX_MEMO, t, "Tax withheld (memo)"));
    lines.push(cr(TAX_MEMO_CONTRA, t, "Tax withheld (memo)"));
  }
  return lines.filter((l) => l.debit > 0 || l.credit > 0);
}

/** Lines that exactly undo `lines` (used for reversals). */
export function reverseLines(lines: Line[]): Line[] {
  return lines.map((l) => ({ account: l.account, debit: l.credit, credit: l.debit, memo: l.memo }));
}

export function isBalanced(lines: Line[]): boolean {
  const d = lines.reduce((s, l) => s + l.debit, 0);
  const c = lines.reduce((s, l) => s + l.credit, 0);
  return lines.length >= 2 && d === c;
}
