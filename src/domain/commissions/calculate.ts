import { percentOfCents } from "@/lib/money";

/**
 * Weekly commission calculation (docs/design/COMMISSIONS.md). Pure.
 * Inputs are the week's receipts; output is per-line and per-person amounts.
 */

export type CommissionRates = {
  /** Share of loan interest received (net of tax) paid to the loan's officer. */
  loanInterest: number;
  mortgageOriginator: number;
  mortgagePool: number;
};

export const DEFAULT_RATES: CommissionRates = { loanInterest: 0.5, mortgageOriginator: 0.2, mortgagePool: 0.3 };

export type InterestReceipt = { txId: string; at: Date; netCents: number; loanId: string; officerStaffId: string | null; label: string };
export type BankerFee = { mortgageId: string; at: Date; feeCents: number | null; originatorStaffId: string | null; label: string };

/**
 * Every share is whole dollars, like everything else in the game (half a dollar rounds up).
 * Exact: the rate becomes whole basis points first (0.3 × cents could land a hair under a half
 * dollar in floating point). Closed weeks keep the amounts they were closed with.
 */
const share = (cents: number, rate: number) => percentOfCents(cents, rate * 100, "nearest");

export type CommissionLine = {
  kind: "loan_interest" | "mortgage_originator" | "mortgage_pool";
  staffId: string | null;
  label: string;
  /** What the commission is a share of. */
  baseCents: number;
  /** Whole dollars. */
  amountCents: number;
  sourceTxId?: string;
  loanId?: string;
  mortgageId?: string;
};

export type WeekCalculation = {
  lines: CommissionLine[];
  /** Whole-dollar totals per person (only people with something earned). */
  totals: Map<string, number>;
  pool: { totalCents: number; members: number; perPersonCents: number; remainderCents: number };
  /** Lines that can't be paid: no officer, or a mortgage whose fee isn't known. */
  problems: { kind: "no_officer" | "unknown_fee"; label: string; loanId?: string; mortgageId?: string }[];
  companyShareCents: number;
};

export function calculateWeek(input: { interest: InterestReceipt[]; fees: BankerFee[]; roster: string[]; rates?: CommissionRates }): WeekCalculation {
  const rates = input.rates ?? DEFAULT_RATES;
  const lines: CommissionLine[] = [];
  const problems: WeekCalculation["problems"] = [];

  for (const r of input.interest) {
    if (r.netCents <= 0) continue;
    if (!r.officerStaffId) problems.push({ kind: "no_officer", label: r.label, loanId: r.loanId });
    lines.push({
      kind: "loan_interest",
      staffId: r.officerStaffId,
      label: r.label,
      baseCents: r.netCents,
      amountCents: share(r.netCents, rates.loanInterest),
      sourceTxId: r.txId,
      loanId: r.loanId,
    });
  }

  let poolCents = 0;
  let companyShareCents = 0;
  for (const f of input.fees) {
    if (f.feeCents === null) {
      problems.push({ kind: "unknown_fee", label: f.label, mortgageId: f.mortgageId });
      continue;
    }
    if (!f.originatorStaffId) problems.push({ kind: "no_officer", label: f.label, mortgageId: f.mortgageId });
    const originator = share(f.feeCents, rates.mortgageOriginator);
    const pool = share(f.feeCents, rates.mortgagePool);
    poolCents += pool;
    companyShareCents += f.feeCents - originator - pool;
    lines.push({ kind: "mortgage_originator", staffId: f.originatorStaffId, label: f.label, baseCents: f.feeCents, amountCents: originator, mortgageId: f.mortgageId });
  }

  // Equal shares, rounded down to whole dollars; the remainder stays with the company.
  const members = [...new Set(input.roster)];
  const perPersonCents = members.length ? Math.floor(poolCents / members.length / 100) * 100 : 0;
  for (const staffId of members) {
    if (perPersonCents > 0) lines.push({ kind: "mortgage_pool", staffId, label: "Weekly mortgage pool share", baseCents: poolCents, amountCents: perPersonCents });
  }
  const remainderCents = poolCents - perPersonCents * members.length;
  companyShareCents += remainderCents;

  const totals = new Map<string, number>();
  for (const l of lines) if (l.staffId) totals.set(l.staffId, (totals.get(l.staffId) ?? 0) + l.amountCents);
  for (const [id, c] of totals) if (c <= 0) totals.delete(id);

  return { lines, totals, pool: { totalCents: poolCents, members: members.length, perPersonCents, remainderCents }, problems, companyShareCents };
}
