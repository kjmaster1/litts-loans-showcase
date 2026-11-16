import type { Category } from "./categories";
import type { Line } from "./posting";

/**
 * Mortgage pass-through pairing (docs/design/LEDGER.md). Each mortgage event is
 * two bank rows at the same moment for the same address: money in from the
 * buyer and money out to the State. The difference stays with the company —
 * the broker fee at origination, broker interest on instalments.
 */
export const CLEARING = "1110";
const PAIR_WINDOW_MS = 5_000;

export type Leg = {
  id: string;
  category: Category;
  address: string;
  occurredAt: Date;
  amountCents: number;
  taxCents: number;
};

export type Pair = {
  kind: "origination" | "repayment";
  address: string;
  inLeg: Leg;
  outLeg: Leg;
  /** Net cash kept: (in − tax) − out. */
  residualCents: number;
};

const KIND: Partial<Record<Category, { kind: Pair["kind"]; side: "in" | "out" }>> = {
  "mortgage.origination_in": { kind: "origination", side: "in" },
  "mortgage.origination_out": { kind: "origination", side: "out" },
  "mortgage.repayment_in": { kind: "repayment", side: "in" },
  "mortgage.repayment_out": { kind: "repayment", side: "out" },
};

/**
 * Greedily pairs unpaired legs: same kind, same address, within a few seconds,
 * closest in time first. Returns pairs; legs without a partner are left alone.
 */
export function pairMortgageLegs(legs: Leg[]): Pair[] {
  const ins = legs.filter((l) => KIND[l.category]?.side === "in");
  const outs = legs.filter((l) => KIND[l.category]?.side === "out");
  const used = new Set<string>();
  const pairs: Pair[] = [];

  for (const inLeg of [...ins].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())) {
    const kind = KIND[inLeg.category]!.kind;
    const candidates = outs
      .filter(
        (o) =>
          !used.has(o.id) &&
          KIND[o.category]!.kind === kind &&
          o.address === inLeg.address &&
          Math.abs(o.occurredAt.getTime() - inLeg.occurredAt.getTime()) <= PAIR_WINDOW_MS,
      )
      .sort(
        (a, b) =>
          Math.abs(a.occurredAt.getTime() - inLeg.occurredAt.getTime()) -
          Math.abs(b.occurredAt.getTime() - inLeg.occurredAt.getTime()),
      );
    const outLeg = candidates[0];
    if (!outLeg) continue;
    used.add(outLeg.id);
    pairs.push({
      kind,
      address: inLeg.address,
      inLeg,
      outLeg,
      residualCents: inLeg.amountCents - inLeg.taxCents - outLeg.amountCents,
    });
  }
  return pairs;
}

/** Moves the residual out of clearing into income (or reverses if negative). */
export function settlementLines(pair: Pair): Line[] {
  const income = pair.kind === "origination" ? "4100" : "4110";
  const r = pair.residualCents;
  if (r === 0) return [];
  const memo = pair.kind === "origination" ? `Broker fee — ${pair.address}` : `Broker interest — ${pair.address}`;
  return r > 0
    ? [
        { account: CLEARING, debit: r, credit: 0, memo },
        { account: income, debit: 0, credit: r, memo },
      ]
    : [
        { account: income, debit: -r, credit: 0, memo },
        { account: CLEARING, debit: 0, credit: -r, memo },
      ];
}
