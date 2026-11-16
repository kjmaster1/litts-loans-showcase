import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NO_RULE, type AllowanceOutlook, type OutlookStep } from "@/domain/mortgages/allowance-outlook";
import { AllowanceOutlookChart, OutlookFigure } from "./allowance-outlook-chart";
import { outlookChartData, outlookPoints } from "./allowance-outlook-points";

const now = new Date("2026-10-19T20:00:00Z");
const at = (h: number, m = 0) => new Date(now.getTime() + (h * 60 + m) * 60_000);

function outlookOf(steps: Omit<OutlookStep, "balanceCents">[]): AllowanceOutlook {
  let balance = 2_000_000_00;
  const withBalance = steps.map((s) => ({ ...s, balanceCents: (balance += s.deltaCents) }));
  return {
    rule: NO_RULE,
    ruleSource: "adopted",
    readingAt: at(-2),
    bankTo: at(-1),
    bankStale: false,
    nowCents: 2_000_000_00,
    horizon: new Date(now.getTime() + 14 * 86_400_000),
    steps: withBalance,
    lineSteps: withBalance,
    endCents: balance,
    lowest: { at: now, balanceCents: 2_000_000_00, quoteNumber: null },
    behind: 0,
    confirmed: [],
    drafts: [],
  };
}

const hidden = (h: number, m: number, cents: number): Omit<OutlookStep, "balanceCents"> => ({ at: at(h, m), kind: "repayment", deltaCents: cents, label: null, quoteNumber: null });

describe("outlookPoints", () => {
  it("merges hidden repayments within an hour, but never across a signing or a visible repayment", () => {
    const points = outlookPoints(
      outlookOf([
        hidden(1, 0, 10_000_00),
        hidden(1, 30, 20_000_00),
        { at: at(1, 40), kind: "repayment", deltaCents: 5_000_00, label: "1 Own St", quoteNumber: null },
        hidden(1, 50, 30_000_00),
        { at: at(2), kind: "signing", deltaCents: -900_000_00, label: "109 Mirror Park Blvd", quoteNumber: 41 },
        hidden(2, 10, 40_000_00),
        hidden(3, 30, 50_000_00),
      ]),
    );
    expect(points.map((p) => [p.what, p.deltaCents])).toEqual([
      ["2 repayments", 30_000_00],
      ["1 Own St payment", 5_000_00],
      ["1 repayment", 30_000_00],
      ["#41 signs · 109 Mirror Park Blvd", -900_000_00],
      ["1 repayment", 40_000_00],
      ["1 repayment", 50_000_00],
    ]);
    expect(points[0].balanceCents).toBe(2_030_000_00);
    expect(points[3].beforeCents).toBe(2_065_000_00);
  });

  const steps = (): Omit<OutlookStep, "balanceCents">[] => [hidden(1, 0, 10_000_00), hidden(1, 30, 20_000_00), { at: at(2), kind: "signing", deltaCents: -900_000_00, label: "109 Mirror Park Blvd", quoteNumber: 41 }];

  it("renders merged hover text and labelled signings, with nothing per-mortgage for hidden ones", () => {
    // Server render (before hydration): the viewer's zone isn't known yet, so UK time, labelled.
    const html = renderToStaticMarkup(createElement(AllowanceOutlookChart, { now, data: outlookChartData(outlookOf(steps()), false) }));
    expect(html).toContain("2 repayments · +$30,000");
    // Company time (BST): 22:00 UTC is 23:00 in London.
    expect(html).toMatch(/Mon 19 Oct, 23:00 UK time · #41 signs · 109 Mirror Park Blvd · −\$900,000/);
    expect(html).toContain("#41 signs · −$900,000");
    expect(html).not.toContain("$10,000");
    expect(html).not.toContain("$20,000");
    // A compact drawing for phones and a wide one, each with the summary; CSS shows one. The table is in UK time too.
    expect(html.match(/role="img" aria-label="Projected State allowance to Mon 2 Nov, 20:00 UK time: /g)).toHaveLength(2);
    expect(html).toContain('data-variant="compact"');
    expect(html).toContain("When (UK time)");
    expect(html).toContain("Chart times are UK time.");
  });

  it("draws in the viewer's own time zone once it is known", () => {
    const html = renderToStaticMarkup(createElement(OutlookFigure, { now, data: outlookChartData(outlookOf(steps()), false), viewerZone: "America/New_York" }));
    // 22:00 UTC is 18:00 in New York (EDT), with no "UK time" anywhere.
    expect(html).toMatch(/Mon 19 Oct, 18:00 · #41 signs · 109 Mirror Park Blvd · −\$900,000/);
    expect(html).toContain("Chart times are your time (America/New_York).");
    expect(html).toContain("When (your time)");
    expect(html).not.toContain("UK time");
  });
});
