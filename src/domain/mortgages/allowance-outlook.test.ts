import { describe, expect, it } from "vitest";
import { ruleById, type AllowanceRule } from "./allowance";
import {
  allowanceLine,
  allowanceTaken,
  balanceBefore,
  confirmedWorking,
  isBehind,
  NO_RULE,
  previewConfirmation,
  projectOutlook,
  type AllowanceOutlook,
  type OutlookInput,
  type OutlookMortgage,
  type OutlookQuote,
} from "./allowance-outlook";

const $ = (dollars: number) => Math.round(dollars * 100);
const at = (iso: string) => new Date(iso);
const RULE = ruleById("o1-principal4") as AllowanceRule;

const instalments = (n: number, principal: number, total = principal) =>
  Array.from({ length: n }, () => ({ principalCents: $(principal), totalCents: $(total) }));

/** M1: active, 4 × $10,000 principal ($11,000 a week), one paid on 8 Oct 13:00 → next due 15 Oct 13:00. */
function mortgage(over: Partial<OutlookMortgage> = {}): OutlookMortgage {
  return {
    id: "m1",
    label: "1 Alta St",
    status: "active",
    originatedAt: at("2026-10-01T12:00:00Z"),
    instalments: instalments(4, 10_000, 11_000),
    paidAt: [at("2026-10-08T13:00:00Z")],
    ...over,
  };
}

/** Q1: #1, confirmed, $300,000 loan in 3 × $100,000, signing 14 Oct 20:00. */
function quote(over: Partial<OutlookQuote> = {}): OutlookQuote {
  return {
    id: "q1",
    number: 1,
    address: "2 Bay Rd",
    officerStaffId: "officer-1",
    status: "confirmed",
    companyFunded: false,
    loanCents: $(300_000),
    instalments: instalments(3, 100_000, 110_000),
    expectedSigningAt: at("2026-10-14T20:00:00Z"),
    confirmedAt: at("2026-10-12T09:00:00Z"),
    signedAt: null,
    ...over,
  };
}

function base(over: Partial<OutlookInput> = {}): OutlookInput {
  return {
    now: at("2026-10-13T00:00:00Z"),
    reading: { at: at("2026-10-12T06:00:00Z"), balanceCents: $(1_000_000) },
    bankTo: at("2026-10-12T00:00:00Z"),
    rule: RULE,
    knownEvents: [],
    mortgages: [mortgage()],
    quotes: [quote()],
    cushionCents: $(100_000),
    ...over,
  };
}

const stepsOf = (o: AllowanceOutlook) => o.steps.map((s) => [s.at.toISOString(), s.deltaCents, s.balanceCents]);

const BASE_STEPS = [
  ["2026-10-14T20:00:00.000Z", -$(300_000), $(700_000)],
  ["2026-10-15T13:00:00.000Z", $(40_000), $(740_000)],
  ["2026-10-21T20:00:00.000Z", $(400_000), $(1_140_000)],
  ["2026-10-22T13:00:00.000Z", $(40_000), $(1_180_000)],
];

describe("projectOutlook", () => {
  it("projects repayments and confirmed signings to the horizon", () => {
    const o = projectOutlook(base(), "adopted");
    expect(o.nowCents).toBe($(1_000_000));
    expect(stepsOf(o)).toEqual(BASE_STEPS);
    expect(o.steps.map((s) => [s.kind, s.label, s.quoteNumber])).toEqual([
      ["signing", "2 Bay Rd", 1],
      ["repayment", "1 Alta St", null],
      ["repayment", "2 Bay Rd", 1],
      ["repayment", "1 Alta St", null],
    ]);
    expect(o.horizon.toISOString()).toBe("2026-10-27T00:00:00.000Z");
    expect(o.endCents).toBe($(1_180_000));
    expect(o.lowest).toEqual({ at: new Date("2026-10-14T20:00:00Z"), balanceCents: $(700_000), quoteNumber: 1 });
    expect(o.confirmed).toHaveLength(1);
    expect(o.confirmed[0]).toMatchObject({
      quoteId: "q1",
      number: 1,
      signingAt: at("2026-10-14T20:00:00Z"),
      beforeCents: $(1_000_000),
      afterCents: $(700_000),
      verdict: "fits",
      passed: false,
      fitsFrom: null,
    });
    expect(o).toMatchObject({ rule: RULE, ruleSource: "adopted", readingAt: at("2026-10-12T06:00:00Z"), bankStale: false, behind: 0, drafts: [] });
  });

  it("extends the horizon to the latest signing and keeps the lowest point at now when nothing goes below it", () => {
    const o = projectOutlook(base({ quotes: [quote({ expectedSigningAt: at("2026-11-02T10:00:00Z") })] }), "best_fit");
    expect(o.horizon.toISOString()).toBe("2026-11-02T10:00:00.000Z");
    expect(o.steps.at(-1)).toMatchObject({ at: at("2026-11-02T10:00:00Z"), kind: "signing", quoteNumber: 1 });

    const quiet = projectOutlook(base({ quotes: [] }), "adopted");
    expect(quiet.lowest).toEqual({ at: at("2026-10-13T00:00:00Z"), balanceCents: $(1_000_000), quoteNumber: null });
  });

  it("leaves out a mortgage behind on payments, judged against the bank data", () => {
    // M2 paid 1 Oct → next due 8 Oct, before the bank data ends (12 Oct) with no repayment for it.
    const m2 = mortgage({ id: "m2", label: "3 Cove Ln", originatedAt: at("2026-09-24T00:00:00Z"), paidAt: [at("2026-10-01T00:00:00Z")] });
    const defaulted = mortgage({ id: "m4", label: "4 Dune Rd", status: "defaulted", originatedAt: at("2026-09-24T00:00:00Z"), paidAt: [at("2026-10-01T00:00:00Z")] });
    expect(isBehind(m2, at("2026-10-12T00:00:00Z"))).toBe(true);
    expect(isBehind(m2, null)).toBe(false);
    expect(isBehind(mortgage(), at("2026-10-12T00:00:00Z"))).toBe(false);
    // Unpaid since it started: first instalment due 7 days after origination.
    expect(isBehind(mortgage({ paidAt: [], originatedAt: at("2026-10-04T00:00:00Z") }), at("2026-10-12T00:00:00Z"))).toBe(true);
    expect(isBehind(mortgage({ paidAt: [], originatedAt: at("2026-10-06T00:00:00Z") }), at("2026-10-12T00:00:00Z"))).toBe(false);

    const o = projectOutlook(base({ mortgages: [mortgage(), m2, defaulted] }), "adopted");
    expect(o.behind).toBe(1);
    expect(o.steps.some((s) => s.label === "3 Cove Ln" || s.label === "4 Dune Rd")).toBe(false);
    expect(stepsOf(o)).toEqual(BASE_STEPS);
  });

  it("gives an instalment two hours' grace at the end of the bank data, then counts it just after", () => {
    // M5 paid 4 Oct 23:00 → next due 11 Oct 23:00, an hour before the bank data ends (12 Oct 00:00), unpaid.
    const m5 = mortgage({ id: "m5", label: "6 Fern Way", originatedAt: at("2026-09-27T23:00:00Z"), paidAt: [at("2026-10-04T23:00:00Z")] });
    expect(isBehind(m5, at("2026-10-12T00:00:00Z"))).toBe(false);
    expect(isBehind(m5, at("2026-10-12T01:00:00Z"))).toBe(false);
    expect(isBehind(m5, at("2026-10-12T01:00:00.001Z"))).toBe(true);

    // Reading older than the bank data: the late instalment is in neither, so it counts just after the bank's end
    // (before now → in nowCents) and the game's clock carries on from it.
    const o = projectOutlook(base({ reading: { at: at("2026-10-11T06:00:00Z"), balanceCents: $(1_000_000) }, mortgages: [m5], quotes: [] }), "adopted");
    expect(o.behind).toBe(0);
    expect(o.nowCents).toBe($(1_040_000));
    expect(o.steps.map((s) => s.at.toISOString())).toEqual(["2026-10-19T00:00:00.001Z", "2026-10-26T00:00:00.001Z"]);
  });

  it("counts a repayment once whichever of reading and bank is newer", () => {
    // (a) Bank older than the reading: M3's 11 Oct instalment falls between the bank's end and the reading, so the
    // reading already includes it. Only 18 Oct onwards is expected.
    const m3a = mortgage({ id: "m3", label: "5 Elm Ct", originatedAt: at("2026-09-27T00:00:00Z"), paidAt: [at("2026-10-04T00:00:00Z")] });
    const a = projectOutlook(base({ bankTo: at("2026-10-10T00:00:00Z"), mortgages: [mortgage(), m3a] }), "adopted");
    expect(a.nowCents).toBe($(1_000_000));
    expect(a.bankStale).toBe(true);
    expect(a.behind).toBe(0);
    expect(stepsOf(a)).toEqual([
      ["2026-10-14T20:00:00.000Z", -$(300_000), $(700_000)],
      ["2026-10-15T13:00:00.000Z", $(40_000), $(740_000)],
      ["2026-10-18T00:00:00.000Z", $(40_000), $(780_000)],
      ["2026-10-21T20:00:00.000Z", $(400_000), $(1_180_000)],
      ["2026-10-22T13:00:00.000Z", $(40_000), $(1_220_000)],
      ["2026-10-25T00:00:00.000Z", $(40_000), $(1_260_000)],
    ]);

    // (b) Bank newer than the reading: the 11 Oct repayment is a known (bank) event after the reading → +$40,000 once;
    // the next expected one is 7 days after it.
    const m3b = mortgage({ id: "m3", label: "5 Elm Ct", originatedAt: at("2026-10-04T00:00:00Z"), paidAt: [at("2026-10-11T00:00:00Z")] });
    const b = projectOutlook(
      base({
        reading: { at: at("2026-10-10T00:00:00Z"), balanceCents: $(1_000_000) },
        bankTo: at("2026-10-12T00:00:00Z"),
        mortgages: [mortgage(), m3b],
        knownEvents: [{ kind: "repayment", at: at("2026-10-11T00:00:00Z"), grossCents: $(11_000), principalCents: $(10_000), label: "5 Elm Ct" }],
      }),
      "adopted",
    );
    expect(b.nowCents).toBe($(1_040_000));
    const m3Steps = b.steps.filter((s) => s.label === "5 Elm Ct").map((s) => s.at.toISOString());
    expect(m3Steps).toEqual(["2026-10-18T00:00:00.000Z", "2026-10-25T00:00:00.000Z"]);

    // (c) Expected but not yet in the bank: M1's 15 Oct 13:00 instalment is due between the reading and now → in
    // nowCents, not a step. Q1's signing (14 Oct) has passed unsigned, so it is a step at now.
    const c = projectOutlook(base({ now: at("2026-10-16T00:00:00Z") }), "adopted");
    expect(c.nowCents).toBe($(1_040_000));
    expect(c.steps.some((s) => s.at.toISOString() === "2026-10-15T13:00:00.000Z")).toBe(false);
    expect(stepsOf(c).slice(0, 3)).toEqual([
      ["2026-10-16T00:00:00.000Z", -$(300_000), $(740_000)],
      ["2026-10-22T13:00:00.000Z", $(40_000), $(780_000)],
      ["2026-10-23T00:00:00.000Z", $(400_000), $(1_180_000)],
    ]);
  });

  it("signed quote counts only if signed after the reading", () => {
    const after = projectOutlook(base({ quotes: [quote({ signedAt: at("2026-10-12T08:00:00Z") })] }), "adopted");
    expect(after.nowCents).toBe($(700_000));
    expect(after.confirmed).toEqual([]);
    expect(stepsOf(after)).toEqual([
      ["2026-10-15T13:00:00.000Z", $(40_000), $(740_000)],
      ["2026-10-19T08:00:00.000Z", $(400_000), $(1_140_000)],
      ["2026-10-22T13:00:00.000Z", $(40_000), $(1_180_000)],
      ["2026-10-26T08:00:00.000Z", $(400_000), $(1_580_000)],
    ]);

    const before = projectOutlook(base({ quotes: [quote({ signedAt: at("2026-10-12T05:00:00Z") })] }), "adopted");
    expect(before.nowCents).toBe($(1_000_000));
    expect(before.steps.some((s) => s.kind === "signing")).toBe(false);
    expect(before.steps.find((s) => s.label === "2 Bay Rd")?.at).toEqual(at("2026-10-19T05:00:00Z"));
  });

  it("treats a passed, unsigned signing as signing now", () => {
    const o = projectOutlook(base({ quotes: [quote({ expectedSigningAt: at("2026-10-12T20:00:00Z") })] }), "adopted");
    expect(o.nowCents).toBe($(1_000_000));
    expect(o.confirmed[0]).toMatchObject({ signingAt: at("2026-10-13T00:00:00Z"), passed: true, beforeCents: $(1_000_000), afterCents: $(700_000) });
    expect(stepsOf(o)[0]).toEqual(["2026-10-13T00:00:00.000Z", -$(300_000), $(700_000)]);
    // Its repayments follow weekly from now.
    expect(o.steps.find((s) => s.kind === "repayment" && s.quoteNumber === 1)?.at).toEqual(at("2026-10-20T00:00:00Z"));
    expect(o.lowest).toEqual({ at: at("2026-10-13T00:00:00Z"), balanceCents: $(700_000), quoteNumber: 1 });
  });

  it("orders same-time signings by quote number", () => {
    const q3 = quote({ id: "q3", number: 3, loanCents: $(100_000), expectedSigningAt: at("2026-10-15T00:00:00Z") });
    const q2 = quote({ id: "q2", number: 2, loanCents: $(100_000), expectedSigningAt: at("2026-10-15T00:00:00Z") });
    const o = projectOutlook(base({ quotes: [q3, quote(), q2] }), "adopted");
    expect(o.confirmed.map((c) => c.number)).toEqual([1, 2, 3]);
    const [, two, three] = o.confirmed;
    expect(two).toMatchObject({ beforeCents: $(700_000), afterCents: $(600_000) });
    expect(three).toMatchObject({ beforeCents: $(600_000), afterCents: $(500_000) });
    expect(two.beforeCents).toBeGreaterThan(three.beforeCents);
  });

  it("signs before repaying at the same instant", () => {
    const m = mortgage({ id: "m5", label: "6 Fern Way", originatedAt: at("2026-10-07T20:00:00Z"), paidAt: [] });
    const o = projectOutlook(base({ mortgages: [m] }), "adopted");
    expect(o.steps.slice(0, 2).map((s) => [s.at.toISOString(), s.kind])).toEqual([
      ["2026-10-14T20:00:00.000Z", "signing"],
      ["2026-10-14T20:00:00.000Z", "repayment"],
    ]);
    expect(o.confirmed[0].beforeCents).toBe($(1_000_000));
  });

  it("projects no repayments without a rule", () => {
    const o = projectOutlook(
      base({
        rule: null,
        knownEvents: [
          { kind: "origination", at: at("2026-10-12T10:00:00Z"), loanCents: $(200_000), label: "7 Glen Dr" },
          { kind: "repayment", at: at("2026-10-12T11:00:00Z"), grossCents: $(11_000), principalCents: $(10_000), label: "1 Alta St" },
        ],
      }),
      "none",
    );
    expect(o.rule).toEqual(NO_RULE);
    expect(NO_RULE).toEqual({ id: "none", label: "No allowance rule adopted", originationMultiple: 1, repaymentBasis: "principal", repaymentMultiple: 0 });
    expect(o.ruleSource).toBe("none");
    expect(o.nowCents).toBe($(800_000));
    expect(stepsOf(o)).toEqual([["2026-10-14T20:00:00.000Z", -$(300_000), $(500_000)]]);
    expect(o.endCents).toBe($(500_000));
  });

  it("uses the rule's repayment basis", () => {
    const o = projectOutlook(base({ rule: ruleById("o1-gross4") }), "adopted");
    expect(stepsOf(o)).toEqual([
      ["2026-10-14T20:00:00.000Z", -$(300_000), $(700_000)],
      ["2026-10-15T13:00:00.000Z", $(44_000), $(744_000)],
      ["2026-10-21T20:00:00.000Z", $(440_000), $(1_184_000)],
      ["2026-10-22T13:00:00.000Z", $(44_000), $(1_228_000)],
    ]);
  });

  it("ignores company-funded quotes", () => {
    const cf = quote({ id: "q6", number: 6, companyFunded: true, loanCents: $(500_000), expectedSigningAt: at("2026-10-15T00:00:00Z") });
    const cfDraft = quote({ id: "q7", number: 7, status: "draft", companyFunded: true, confirmedAt: null, expectedSigningAt: at("2026-11-20T00:00:00Z") });
    const o = projectOutlook(base({ quotes: [quote(), cf, cfDraft] }), "adopted");
    expect(stepsOf(o)).toEqual(BASE_STEPS);
    expect(o.confirmed.map((c) => c.number)).toEqual([1]);
    expect(o.drafts).toEqual([]);
    expect(o.horizon.toISOString()).toBe("2026-10-27T00:00:00.000Z");
  });

  it("grades Tight under the cushion and Short below zero", () => {
    const tight = projectOutlook(base({ quotes: [quote({ loanCents: $(950_000) })] }), "adopted");
    expect(tight.confirmed[0]).toMatchObject({ afterCents: $(50_000), verdict: "tight", fitsFrom: null });
    const short = projectOutlook(base({ quotes: [quote({ loanCents: $(1_050_000) })] }), "adopted");
    expect(short.confirmed[0]).toMatchObject({ afterCents: -$(50_000), verdict: "short", fitsFrom: null });
    expect(short.lowest).toEqual({ at: at("2026-10-14T20:00:00Z"), balanceCents: -$(50_000), quoteNumber: 1 });
    // Exactly the cushion left fits; exactly zero is tight.
    expect(projectOutlook(base({ quotes: [quote({ loanCents: $(900_000) })] }), "adopted").confirmed[0].verdict).toBe("fits");
    expect(projectOutlook(base({ quotes: [quote({ loanCents: $(1_000_000) })] }), "adopted").confirmed[0].verdict).toBe("tight");
  });

  it("shows a short draft's what-if and when it would fit", () => {
    const draft = quote({ id: "d", number: 4, status: "draft", confirmedAt: null, loanCents: $(900_000), instalments: instalments(3, 300_000), expectedSigningAt: at("2026-10-14T22:00:00Z") });
    const noTime = quote({ id: "d2", number: 8, status: "draft", confirmedAt: null, expectedSigningAt: null });
    const without = projectOutlook(base(), "adopted");
    const o = projectOutlook(base({ quotes: [quote(), draft, noTime] }), "adopted");
    expect(o.drafts).toEqual([
      {
        quoteId: "d",
        number: 4,
        signingAt: at("2026-10-14T22:00:00Z"),
        passed: false,
        beforeCents: $(700_000),
        afterCents: -$(200_000),
        verdict: "short",
        fitsFrom: at("2026-10-21T20:00:00Z"),
      },
    ]);
    // Drafts never move the line.
    expect(o.confirmed).toEqual(without.confirmed);
    expect(o.steps).toEqual(without.steps);
    expect(o.lowest).toEqual(without.lowest);
    expect(o.endCents).toBe(without.endCents);
  });

  it("finds when a draft fits without pushing a later confirmed signing short", () => {
    // Q5 (#5, $1.1m) signs 22 Oct 20:00. Alone the draft would fit after Q1's 21 Oct repayment, but then Q5 would be
    // short; it fits only once Q5's first repayment (29 Oct 20:00, 4 × $550,000) is in.
    const q5 = quote({ id: "q5", number: 5, loanCents: $(1_100_000), instalments: instalments(2, 550_000), expectedSigningAt: at("2026-10-22T20:00:00Z") });
    const draft = quote({ id: "d", number: 4, status: "draft", confirmedAt: null, loanCents: $(900_000), instalments: instalments(3, 300_000), expectedSigningAt: at("2026-10-14T22:00:00Z") });
    const o = projectOutlook(base({ quotes: [quote(), q5, draft] }), "adopted");
    expect(o.confirmed.map((c) => [c.number, c.afterCents, c.verdict])).toEqual([
      [1, $(700_000), "fits"],
      [5, $(80_000), "tight"],
    ]);
    expect(o.drafts[0]).toMatchObject({ verdict: "short", fitsFrom: at("2026-10-29T20:00:00Z") });

    // Too big to fit within 60 days of its signing.
    const huge = projectOutlook(base({ quotes: [quote(), { ...draft, loanCents: $(10_000_000) }] }), "adopted");
    expect(huge.drafts[0]).toMatchObject({ verdict: "short", fitsFrom: null });
  });

  it("evaluates a draft whose signing time has passed at now, and fitsFrom only when short", () => {
    const draft = quote({ id: "d", number: 4, status: "draft", confirmedAt: null, loanCents: $(100_000), expectedSigningAt: at("2026-10-12T00:00:00Z") });
    const o = projectOutlook(base({ quotes: [quote(), draft] }), "adopted");
    expect(o.drafts[0]).toEqual({
      quoteId: "d",
      number: 4,
      signingAt: at("2026-10-13T00:00:00Z"),
      passed: true,
      beforeCents: $(1_000_000),
      afterCents: $(900_000),
      verdict: "fits",
      fitsFrom: null,
    });
  });

  it("whole dollars throughout", () => {
    const odd = mortgage({ instalments: Array.from({ length: 4 }, () => ({ principalCents: 1_000_037, totalCents: 1_100_049 })) });
    const q = quote({ loanCents: 30_000_049, instalments: Array.from({ length: 3 }, () => ({ principalCents: 10_000_016, totalCents: 11_000_033 })) });
    const draft = quote({ id: "d", number: 4, status: "draft", confirmedAt: null, loanCents: 90_000_051, expectedSigningAt: at("2026-10-14T22:00:00Z") });
    const o = projectOutlook(base({ rule: ruleById("o1-gross4"), mortgages: [odd], quotes: [q, draft] }), "adopted");
    const amounts = [
      o.nowCents,
      o.endCents,
      o.lowest.balanceCents,
      ...o.steps.flatMap((s) => [s.deltaCents, s.balanceCents]),
      ...[...o.confirmed, ...o.drafts].flatMap((c) => [c.beforeCents, c.afterCents]),
    ];
    expect(o.steps.length).toBeGreaterThan(0);
    for (const cents of amounts) expect(Math.abs(cents) % 100).toBe(0);
  });
});

describe("previewConfirmation", () => {
  const draftE = quote({
    id: "e",
    number: 5,
    officerStaffId: "officer-2",
    status: "draft",
    confirmedAt: null,
    loanCents: $(800_000),
    instalments: instalments(2, 400_000),
    expectedSigningAt: at("2026-10-20T00:00:00Z"),
  });

  it("reports the confirmed quotes a confirmation would push short", () => {
    const p = previewConfirmation(base({ quotes: [quote(), draftE] }), "e", at("2026-10-14T10:00:00Z"));
    expect(p.nowCents).toBe($(1_000_000));
    expect(p.repayments).toEqual({ count: 0, cents: 0 });
    expect(p.signings).toEqual({ numbers: [], cents: 0 });
    expect(p.quote).toEqual({
      quoteId: "e",
      number: 5,
      signingAt: at("2026-10-14T10:00:00Z"),
      passed: false,
      beforeCents: $(1_000_000),
      afterCents: $(200_000),
      verdict: "fits",
      fitsFrom: null,
    });
    expect(p.knockOn).toEqual([{ quoteId: "q1", number: 1, officerStaffId: "officer-1", shortByCents: $(100_000) }]);
  });

  it("counts the confirmed quote's own repayments before a later signing", () => {
    // D ($900,000; 3 × $300,000) at 14 Oct 22:00 repays on 21 and 28 Oct 22:00 (+$1,200,000 each). Q5 ($1,100,000)
    // signs 29 Oct 00:00: $1,580,000 before it without D → $480,000 after; with D −$900,000 + 2 × $1,200,000 → $1,980,000.
    const q5 = quote({ id: "q5", number: 5, loanCents: $(1_100_000), expectedSigningAt: at("2026-10-29T00:00:00Z") });
    const d = { ...draftE, loanCents: $(900_000), instalments: instalments(3, 300_000) };
    expect(projectOutlook(base({ quotes: [quote(), q5] }), "adopted").confirmed[1]).toMatchObject({ number: 5, afterCents: $(480_000) });
    const p = previewConfirmation(base({ quotes: [quote(), q5, d] }), "e", at("2026-10-14T22:00:00Z"));
    expect(p.quote).toMatchObject({ afterCents: -$(200_000), verdict: "short" });
    expect(p.knockOn).toEqual([]);
  });

  it("doesn't count the quote's own repayment at the same instant as a later signing", () => {
    // D ($900,000; 9 × $100,000 → +$400,000 a week) at 14 Oct 22:00 repays on 21 and 28 Oct 22:00. Q5 ($1,200,000)
    // signs at 28 Oct 22:00 too, before D's repayment: $1,580,000 − $1,200,000 = $380,000 without D; with D
    // − $900,000 + $400,000 (21 Oct only) → −$120,000.
    const q5 = quote({ id: "q5", number: 5, loanCents: $(1_200_000), expectedSigningAt: at("2026-10-28T22:00:00Z") });
    const d = { ...draftE, loanCents: $(900_000), instalments: instalments(9, 100_000) };
    expect(projectOutlook(base({ quotes: [quote(), q5] }), "adopted").confirmed[1]).toMatchObject({ number: 5, afterCents: $(380_000), verdict: "fits" });
    const p = previewConfirmation(base({ quotes: [quote(), q5, d] }), "e", at("2026-10-14T22:00:00Z"));
    expect(p.knockOn).toEqual([{ quoteId: "q5", number: 5, officerStaffId: "officer-1", shortByCents: $(120_000) }]);
  });

  it("shows the working up to the signing", () => {
    const p = previewConfirmation(base({ quotes: [quote(), draftE] }), "e", at("2026-10-22T00:00:00Z"));
    expect(p.repayments).toEqual({ count: 2, cents: $(440_000) });
    expect(p.signings).toEqual({ numbers: [1], cents: $(300_000) });
    expect(p.quote).toMatchObject({ beforeCents: $(1_140_000), afterCents: $(340_000), verdict: "fits" });
    expect(p.nowCents + p.repayments.cents - p.signings.cents).toBe(p.quote.beforeCents);
    expect(p.knockOn).toEqual([]);
  });

  it("gives a short preview its fits-from date", () => {
    const p = previewConfirmation(base({ quotes: [quote(), { ...draftE, loanCents: $(900_000) }] }), "e", at("2026-10-14T22:00:00Z"));
    expect(p.quote).toMatchObject({ beforeCents: $(700_000), afterCents: -$(200_000), verdict: "short", fitsFrom: at("2026-10-21T20:00:00Z") });
    expect(p.knockOn).toEqual([]);
  });

  it("re-times a confirmed quote as if it weren't in the projection yet", () => {
    const p = previewConfirmation(base(), "q1", at("2026-10-20T00:00:00Z"));
    expect(p.signings).toEqual({ numbers: [], cents: 0 });
    expect(p.repayments).toEqual({ count: 1, cents: $(40_000) });
    expect(p.quote).toMatchObject({ quoteId: "q1", beforeCents: $(1_040_000), afterCents: $(740_000), verdict: "fits" });
    expect(p.knockOn).toEqual([]);
  });

  it("leaves company-funded quotes out of the allowance", () => {
    const p = previewConfirmation(base({ quotes: [quote(), { ...draftE, companyFunded: true, loanCents: $(5_000_000) }] }), "e", at("2026-10-15T00:00:00Z"));
    expect(p.quote).toMatchObject({ beforeCents: $(700_000), afterCents: $(700_000), verdict: "fits", fitsFrom: null });
    expect(p.knockOn).toEqual([]);
  });

  it("refuses a quote that isn't in the input", () => {
    expect(() => previewConfirmation(base(), "missing", at("2026-10-15T00:00:00Z"))).toThrow();
  });
});

describe("the quote page and form", () => {
  const q5 = quote({ id: "q5", number: 5, loanCents: $(200_000), instalments: instalments(2, 100_000), expectedSigningAt: at("2026-10-16T00:00:00Z") });

  it("reads a confirmed quote's working off the outlook, as a preview would work it out", () => {
    const input = base({ quotes: [quote(), q5] });
    const w = confirmedWorking(projectOutlook(input, "adopted"), "q5")!;
    expect(w.repayments).toEqual({ count: 1, cents: $(40_000) });
    expect(w.signings).toEqual({ numbers: [1], cents: $(300_000) });
    expect(w.quote).toMatchObject({ number: 5, beforeCents: $(740_000), afterCents: $(540_000), verdict: "fits" });
    expect(w.nowCents + w.repayments.cents - w.signings.cents).toBe(w.quote.beforeCents);
    const p = previewConfirmation(input, "q5", q5.expectedSigningAt!);
    expect({ ...w, knockOn: p.knockOn }).toEqual(p);
    // Only confirmed, unsigned quotes have one.
    expect(confirmedWorking(projectOutlook(base({ quotes: [{ ...q5, status: "draft" }] }), "adopted"), "q5")).toBeNull();
  });

  it("gives the form the line without the quote being edited", () => {
    const now = at("2026-10-13T00:00:00Z");
    const o = projectOutlook(base(), "adopted");
    const without = allowanceLine(o, now, 1);
    expect(without.steps.slice(0, 2).map((s) => s.balanceCents)).toEqual([$(1_040_000), $(1_080_000)]);
    expect(without.confirmedCents).toBe(0);
    expect(balanceBefore(without, at("2026-10-16T00:00:00Z").getTime())).toBe($(1_040_000));
    // A passed time is now; a repayment at the same instant comes after the signing.
    expect(balanceBefore(without, at("2026-10-01T00:00:00Z").getTime())).toBe($(1_000_000));
    expect(balanceBefore(without, at("2026-10-15T13:00:00Z").getTime())).toBe($(1_000_000));

    const all = allowanceLine(o, now, null);
    expect(all.confirmedCents).toBe($(300_000));
    // Another signing at the same instant comes first.
    expect(balanceBefore(all, at("2026-10-14T20:00:00Z").getTime())).toBe($(700_000));
    expect(allowanceTaken(RULE, $(250_000))).toBe($(250_000));
    expect(allowanceTaken(NO_RULE, $(250_000.4))).toBe($(250_000));
  });

  it("agrees with the confirmation preview for a signing past the horizon", () => {
    const now = at("2026-10-13T00:00:00Z");
    const draft = quote({ id: "d", number: 2, status: "draft", expectedSigningAt: null, confirmedAt: null });
    const input = base({ quotes: [quote(), draft] });
    const o = projectOutlook(input, "adopted");
    const late = at("2026-11-20T10:00:00Z");
    expect(late.getTime()).toBeGreaterThan(o.horizon.getTime());
    const p = previewConfirmation(input, "d", late);
    expect(balanceBefore(allowanceLine(o, now, null), late.getTime())).toBe(p.quote.beforeCents);
  });
});
