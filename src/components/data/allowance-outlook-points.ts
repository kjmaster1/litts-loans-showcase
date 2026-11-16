import type { AllowanceOutlook, OutlookStep, QuoteOutlook } from "@/domain/mortgages/allowance-outlook";

/**
 * What the allowance chart is drawn from, built on the server (docs/research/19 §3). The outlook itself never reaches
 * the browser: repayments of mortgages the viewer can't see (`label` null) are merged into one point per hour here, so
 * nothing per-mortgage of theirs is in what the client component receives.
 */

const HOUR_MS = 3_600_000;

/** One point of the line: a signing, a visible repayment, or hidden repayments merged. */
export type OutlookPoint = {
  at: Date;
  kind: OutlookStep["kind"];
  deltaCents: number;
  beforeCents: number;
  balanceCents: number;
  /** Signings: the quote number; repayments: null. */
  quoteNumber: number | null;
  /** Hover / table text. */
  what: string;
  hidden: boolean;
  count: number;
};

export type OutlookChartData = {
  nowCents: number;
  endCents: number;
  horizon: Date;
  lowest: AllowanceOutlook["lowest"];
  points: OutlookPoint[];
  /** Drafts as what-ifs; empty unless the chart shows them. */
  whatIfs: QuoteOutlook[];
};

/** The line's points; hidden repayments with no signing between them, within an hour of the first, become one. */
export function outlookPoints(outlook: AllowanceOutlook): OutlookPoint[] {
  const passed = new Set(outlook.confirmed.filter((c) => c.passed).map((c) => c.number));
  const points: OutlookPoint[] = [];
  let balance = outlook.nowCents;
  for (const s of outlook.steps) {
    const last = points.at(-1);
    const hidden = s.kind === "repayment" && s.label === null;
    if (hidden && last?.hidden && s.at.getTime() - last.at.getTime() < HOUR_MS) {
      last.count++;
      last.deltaCents += s.deltaCents;
      last.balanceCents = s.balanceCents;
      last.what = `${last.count} repayments`;
    } else {
      const what =
        s.kind === "signing"
          ? `#${s.quoteNumber} signs${s.label ? ` · ${s.label}` : ""}${s.quoteNumber !== null && passed.has(s.quoteNumber) ? " (signing time passed, counted now)" : ""}`
          : hidden
            ? "1 repayment"
            : `${s.label} payment`;
      points.push({ at: s.at, kind: s.kind, deltaCents: s.deltaCents, beforeCents: balance, balanceCents: s.balanceCents, quoteNumber: s.kind === "signing" ? s.quoteNumber : null, what, hidden, count: 1 });
    }
    balance = s.balanceCents;
  }
  return points;
}

export function outlookChartData(outlook: AllowanceOutlook, drafts: boolean): OutlookChartData {
  return {
    nowCents: outlook.nowCents,
    endCents: outlook.endCents,
    horizon: outlook.horizon,
    lowest: outlook.lowest,
    points: outlookPoints(outlook),
    whatIfs: drafts ? outlook.drafts : [],
  };
}
