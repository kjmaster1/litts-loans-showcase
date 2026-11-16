/**
 * State allowance tracker (docs/design/MORTGAGES.md). Pure.
 *
 * Nobody knows exactly how the game moves the allowance (owner: "each payment
 * should give 4× back"; origination effect unknown). So candidate rules are
 * scored against the balance readings: for every pair of consecutive readings,
 * the observed change is compared with the change each rule predicts from the
 * events in between.
 */

export type AllowanceReading = { id: string; at: Date; balanceCents: number };

export type AllowanceEvent =
  | { kind: "origination"; at: Date; loanCents: number; label: string }
  | { kind: "repayment"; at: Date; grossCents: number; principalCents: number; label: string }
  /** Deduction stated by the game itself (legacy "full loan amount x5 : n"). */
  | { kind: "sanction"; at: Date; amountCents: number; label: string };

export type AllowanceRule = {
  id: string;
  label: string;
  originationMultiple: number;
  repaymentBasis: "gross" | "principal";
  repaymentMultiple: number;
};

const ORIGINATION = [1, 4, 5, 0];
const REPAYMENT: [AllowanceRule["repaymentBasis"], number][] = [
  ["gross", 4],
  ["principal", 4],
  ["principal", 1],
  ["gross", 1],
];

export const ALLOWANCE_RULES: AllowanceRule[] = ORIGINATION.flatMap((o) =>
  REPAYMENT.map(([basis, r]) => ({
    id: `o${o}-${basis}${r}`,
    label: `${o === 0 ? "No change" : `−${o === 1 ? "" : `${o}× `}loan amount`} when a mortgage starts; +${r === 1 ? "" : `${r}× `}${basis === "gross" ? "weekly payment" : "principal"} per payment`,
    originationMultiple: o,
    repaymentBasis: basis,
    repaymentMultiple: r,
  })),
);

export function ruleById(id: string | null | undefined): AllowanceRule | null {
  return ALLOWANCE_RULES.find((r) => r.id === id) ?? null;
}

export function effect(rule: AllowanceRule, e: AllowanceEvent): number {
  switch (e.kind) {
    case "origination":
      return -rule.originationMultiple * e.loanCents;
    case "repayment":
      return rule.repaymentMultiple * (rule.repaymentBasis === "gross" ? e.grossCents : e.principalCents);
    case "sanction":
      return -e.amountCents;
  }
}

export function predictedChange(rule: AllowanceRule, events: AllowanceEvent[], from: Date, to: Date): number {
  return events.filter((e) => e.at > from && e.at <= to).reduce((s, e) => s + effect(rule, e), 0);
}

export type AllowanceInterval = {
  from: AllowanceReading;
  to: AllowanceReading;
  observedCents: number;
  events: AllowanceEvent[];
  predicted: Record<string, number>;
};

export type RuleScore = { rule: AllowanceRule; totalErrorCents: number; exact: number; intervals: number };

export type AllowanceFit = {
  intervals: AllowanceInterval[];
  /** Best first. Only intervals with at least one event count towards the score. */
  ranking: RuleScore[];
  /** Enough evidence to tell the rules apart. */
  conclusive: boolean;
};

/** Differences of up to $1 per event are treated as rounding. */
const TOLERANCE_PER_EVENT = 100;

export function fitAllowance(readings: AllowanceReading[], events: AllowanceEvent[], rules: AllowanceRule[] = ALLOWANCE_RULES): AllowanceFit {
  const sorted = [...readings].sort((a, b) => a.at.getTime() - b.at.getTime());
  const intervals: AllowanceInterval[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const from = sorted[i - 1];
    const to = sorted[i];
    const between = events.filter((e) => e.at > from.at && e.at <= to.at);
    intervals.push({
      from,
      to,
      observedCents: to.balanceCents - from.balanceCents,
      events: between,
      predicted: Object.fromEntries(rules.map((r) => [r.id, between.reduce((s, e) => s + effect(r, e), 0)])),
    });
  }

  const informative = intervals.filter((iv) => iv.events.length > 0);
  const ranking = rules
    .map((rule) => {
      let total = 0;
      let exact = 0;
      for (const iv of informative) {
        const err = Math.abs(iv.observedCents - iv.predicted[rule.id]);
        total += err;
        if (err <= TOLERANCE_PER_EVENT * iv.events.length) exact++;
      }
      return { rule, totalErrorCents: total, exact, intervals: informative.length };
    })
    .sort((a, b) => b.exact - a.exact || a.totalErrorCents - b.totalErrorCents);

  const [best, second] = ranking;
  const conclusive =
    !!best && best.intervals > 0 && best.exact === best.intervals && (!second || second.exact < best.exact || second.totalErrorCents > best.totalErrorCents);
  return { intervals, ranking, conclusive };
}

/** Last reading plus what `rule` predicts for everything after it. */
export function expectedBalance(readings: AllowanceReading[], events: AllowanceEvent[], rule: AllowanceRule, now: Date = new Date()) {
  const last = [...readings].sort((a, b) => b.at.getTime() - a.at.getTime())[0];
  if (!last) return null;
  const since = events.filter((e) => e.at > last.at && e.at <= now);
  return { from: last, events: since, balanceCents: last.balanceCents + since.reduce((s, e) => s + effect(rule, e), 0) };
}

/** "The full loan amount x5 : 382010 has been deducted…" → $382,010. */
export function sanctionFromStatus(text: string | null): number | null {
  const m = text && /x\s*\d+\s*:\s*([\d,]+)\s+has been deducted/i.exec(text);
  return m ? Number(m[1].replace(/,/g, "")) * 100 : null;
}
