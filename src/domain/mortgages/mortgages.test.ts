import { DEFAULT_SETTINGS } from "@/domain/settings";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ALLOWANCE_RULES, expectedBalance, fitAllowance, ruleById, sanctionFromStatus } from "./allowance";
import { duplicateCandidates, problemsForNewMortgage, repaymentMortgage, type ExistingMortgage, type RepaymentCandidate } from "./identity";
import { looksLikeAddress, parseTablet } from "./parse-tablet";
import { analyseMortgage, bankerFeeBasis, mortgageGuidelines, mortgageSchedule } from "./schedule";

const SAMPLE = readFileSync("tests/fixtures/paste-mortgage.txt", "utf8");
/** The bad paste of 2026-10-12, anonymised: heading copied, address missing, Loan details closed. */
const HEADING_ONLY = SAMPLE.replace("117 Invention Ct", "Sale Agreement - Financed\nPROPERTIES\nPAYMENTS").replace(/Loan details\r?\n[\s\S]*?(?=Agency commission)/, "Loan details\n");

describe("parseTablet", () => {
  it("reads every field of the 117 Invention Ct agreement", () => {
    const { mortgages, ignoredLines } = parseTablet(SAMPLE);
    expect(ignoredLines).toEqual([]);
    expect(mortgages).toHaveLength(1);
    expect(mortgages[0]).toMatchObject({
      address: "117 Invention Ct",
      propertyType: "House",
      landCount: 1,
      priceCents: 73_385_600,
      paidSoFarCents: 20_303_000,
      instalments: 52,
      weeklyCents: 1_300_300,
      remainingCents: 67_628_800,
      paidCount: 1,
      upcomingCount: 52,
      downPaymentCents: 6_893_900,
      loanCents: 62_044_700,
      brokerInterestCents: 3_722_700,
      federalInterestCents: 1_861_400,
      termMonths: 12,
      fedRateBp: 300,
      brokerRateBp: 600,
      lateFeeCents: 50_000,
      gracePeriodDays: 7,
      brokerFeeCents: 5_515_100,
      agencyCommissionCents: 4_447_000,
      status: "Financed",
      owner: "Dynasty 8 Real Estate",
      agency: "Fairbanks Properties",
      financeCompany: "Litt's Loans",
      totalValueCents: 73_385_600,
      afterTaxCents: 76_832_600,
      warnings: [],
    });
    expect(mortgages[0].agent?.stateId).toBe(6937);
    expect(mortgages[0].officer?.stateId).toBe(3628);
    expect(mortgages[0].buyer?.stateId).toBe(1632);
  });

  it("accepts several agreements pasted one after another, with Windows line endings", () => {
    const two = `${SAMPLE}\r\n${SAMPLE.replace("117 Invention Ct", "102 Sustancia Rd")}`.replace(/\n/g, "\r\n");
    const { mortgages } = parseTablet(two);
    expect(mortgages.map((m) => m.address)).toEqual(["117 Invention Ct", "102 Sustancia Rd"]);
  });

  it("warns instead of failing when fields are missing", () => {
    const partial = SAMPLE.split("\n").filter((l) => !/Loan amount|\$620,447/.test(l)).join("\n");
    const [m] = parseTablet(partial).mortgages;
    expect(m.loanCents).toBeNull();
    expect(m.warnings).toContain("No loan amount.");
  });

  // 2026-10-12: copied from the tablet's heading down, a paste became a mortgage called "Sale Agreement - Financed".
  const HEADING = "Sale Agreement - Financed\nPROPERTIES\nPAYMENTS\n";
  /** "Loan details" closed on the tablet: everything between it and "Agency commission" is missing. */
  const collapsed = (text: string) => text.replace(/Loan details\r?\n[\s\S]*?(?=Agency commission)/, "Loan details\n");

  it("skips the tablet's heading and tabs copied above the address", () => {
    const [m] = parseTablet(HEADING + SAMPLE).mortgages;
    expect(m).toMatchObject({ address: "117 Invention Ct", addressRecognised: true, propertyType: "House", priceCents: 73_385_600, warnings: [] });
    expect(m.skippedLines).toEqual(["Sale Agreement - Financed", "PROPERTIES", "PAYMENTS"]);
    expect(m.raw.startsWith("Sale Agreement - Financed")).toBe(true); // kept verbatim
  });

  it("finds each address when several agreements carry the heading", () => {
    const two = HEADING + SAMPLE + "\n" + HEADING + SAMPLE.replace("117 Invention Ct", "102 Sustancia Rd");
    expect(parseTablet(two).mortgages.map((m) => [m.address, m.skippedLines.length])).toEqual([
      ["117 Invention Ct", 3],
      ["102 Sustancia Rd", 3],
    ]);
  });

  it("says when no line is an address, and when Loan details was closed", () => {
    const [noAddress] = parseTablet(SAMPLE.replace("117 Invention Ct", "Sale Agreement - Financed")).mortgages;
    expect(noAddress.addressRecognised).toBe(false);
    expect(noAddress.warnings.join(" ")).toMatch(/No property address/);
    const [closed] = parseTablet(collapsed(SAMPLE)).mortgages;
    expect(closed).toMatchObject({ downPaymentCents: null, loanCents: null, agencyCommissionCents: 4_447_000, instalments: 52 });
    expect(closed.warnings.join(" ")).toMatch(/Loan details.*closed/);
  });

  it("recognises addresses by their house number", () => {
    for (const a of ["107 Amarillo Vista", "103 Forum Dr, Apt 2I", "1 Hangman Ave", "12A Grove St"]) expect(looksLikeAddress(a), a).toBe(true);
    for (const a of ["Sale Agreement - Financed", "PROPERTIES", "PAYMENTS", "1 land", "$155,551", "House", "Paid so far"]) expect(looksLikeAddress(a), a).toBe(false);
  });
});

describe("new mortgage records", () => {
  it("need an address, buyer, down payment, loan and payment count", () => {
    expect(problemsForNewMortgage(parseTablet(SAMPLE).mortgages[0])).toEqual([]);
    expect(problemsForNewMortgage(parseTablet(HEADING_ONLY).mortgages[0])).toHaveLength(2); // no address, no loan details
  });

  it("may duplicate the same buyer's mortgage at the same price or loan, or one not pasted yet", () => {
    const t = { buyer: { stateId: 9408 }, priceCents: 15_555_100, loanCents: null };
    const m = (id: string, over: Partial<ExistingMortgage>): ExistingMortgage => ({ id, buyerStateId: 9408, priceCents: 1, loanCents: 1, lastTabletAt: new Date(), ...over });
    const found = duplicateCandidates(t, [
      m("same-price", { priceCents: 15_555_100 }),
      m("other-price", {}),
      m("unpasted", { lastTabletAt: null }),
      m("other-buyer", { buyerStateId: 1, priceCents: 15_555_100 }),
    ]);
    expect(found.map((x) => x.id)).toEqual(["same-price", "unpasted"]);
    expect(duplicateCandidates({ ...t, buyer: null }, [m("same-price", { priceCents: 15_555_100 })])).toEqual([]);
  });
});

describe("mortgageSchedule", () => {
  const terms = {
    loanCents: 62_044_700,
    brokerInterestCents: 3_722_700,
    federalInterestCents: 1_861_400,
    instalments: 52,
    originatedAt: new Date("2026-10-08T05:03:09Z"),
    gracePeriodDays: 7,
  };

  it("matches the tablet's Payments tab (rounded down, last takes the remainder)", () => {
    const s = mortgageSchedule(terms);
    expect(s[0]).toMatchObject({ principalCents: 1_193_100, brokerInterestCents: 71_500, totalCents: 1_300_300 });
    expect(s[0].principalCents + s[0].brokerInterestCents).toBe(1_264_600); // "$12,646" in
    expect(s[51]).toMatchObject({ principalCents: 1_196_600 });
    expect(s[51].principalCents + s[51].brokerInterestCents).toBe(1_272_800); // "$12,728" in
    expect(s.reduce((a, r) => a + r.principalCents, 0)).toBe(terms.loanCents);
    expect(s[0].dueAt.toISOString()).toBe("2026-10-15T05:03:09.000Z");
  });

  it("tracks payment state against due dates and the grace period", () => {
    const pay = (i: number) => ({ txId: `t${i}`, occurredAt: new Date(Date.UTC(2026, 9, 15 + 7 * i)), grossCents: 1_300_300, taxCents: 35_700, toStateCents: 1_193_100 });
    expect(analyseMortgage(terms, [], new Date("2026-10-14T00:00:00Z")).state.kind).toBe("on_track");
    expect(analyseMortgage(terms, [], new Date("2026-10-18T00:00:00Z")).state).toMatchObject({ kind: "late", overdue: 1 });
    expect(analyseMortgage(terms, [], new Date("2026-10-25T00:00:00Z")).state).toMatchObject({ kind: "behind", overdue: 2 });
    const a = analyseMortgage(terms, [pay(0), pay(1)], new Date("2026-10-25T00:00:00Z"));
    expect(a.state.kind).toBe("on_track");
    expect(a.paidCount).toBe(2);
    expect(a.brokerInterestReceivedCents).toBe(2 * 71_500);
    expect(a.matched[0].differenceCents).toBe(0);
  });
});

describe("mortgageGuidelines", () => {
  // 117 Invention Ct (8 Oct): $55,151 fee (8%) on $68,939 + $620,447, 6% broker.
  const base = { brokerRateBp: 600, fedRateBp: 300, brokerFeeCents: 5_515_100, downPaymentCents: 6_893_900, loanCents: 62_044_700 };
  const state = (originatedAt: Date | null, other = false) => ({ buyerHasOtherMortgage: other, funding: "state" as const, originatedAt });
  const before = new Date("2026-10-08T12:00:00Z");
  const after = new Date("2026-10-15T09:00:00Z");

  it("measures the banker fee against down payment + loan, not the price", () => {
    // Owner's example: 112 West Mirror Drive, $10,000 on $30,000 + $170,000 = 5%.
    expect(bankerFeeBasis({ downPaymentCents: 3_000_000, loanCents: 17_000_000 })).toBe(20_000_000);
  });

  it("holds mortgages arranged from 15 Oct to the federal maximums (owner, 2026-10-15)", () => {
    // Arranged before the rules: nothing to flag (the old 7.5–15% range is gone too).
    expect(mortgageGuidelines(base, state(before))).toEqual([]);
    const flags = mortgageGuidelines(base, state(after));
    expect(flags).toEqual([
      {
        level: "breach",
        rule: "federal_maximum",
        text: "Banker fee $55,151 (8%) is above the federal maximum of 5% ($34,470) for mortgages up to $1,000,000",
      },
    ]);
    // Not yet in the books (a new tablet paste): the rules apply.
    expect(mortgageGuidelines(base, state(null))).toEqual(flags);
    // The tablet rounds the fee up: $34,469.30 → $34,470 is within, a dollar more isn't.
    expect(mortgageGuidelines({ ...base, brokerFeeCents: 3_447_000 }, state(after))).toEqual([]);
    expect(mortgageGuidelines({ ...base, brokerFeeCents: 3_447_100 }, state(after))).toHaveLength(1);
    // Company-funded mortgages are exempt.
    expect(mortgageGuidelines({ ...base, fedRateBp: null }, { buyerHasOtherMortgage: false, funding: "company", originatedAt: after })).toEqual([]);
  });

  it("keeps the fed-rate checks", () => {
    const ok = { ...base, brokerFeeCents: 3_000_000 };
    expect(mortgageGuidelines({ ...ok, fedRateBp: 250 }, state(after)).map((f) => f.level)).toEqual(["breach"]);
    expect(mortgageGuidelines(ok, state(after, true))[0].text).toMatch(/primary residence/);
  });
});

describe("federal bands", () => {
  it("pick the band by down payment + loan, upper end included", async () => {
    const { federalBandFor, bandLabel } = await import("./federal");
    const g = DEFAULT_SETTINGS.mortgages;
    const at = (dollars: number) => {
      const b = federalBandFor(dollars * 100, g);
      return [bandLabel(b), b.bankerFeeMaxPct, b.brokerRateMaxPct];
    };
    expect(at(1)).toEqual(["up to $500,000", 10, 10]);
    expect(at(500_000)).toEqual(["up to $500,000", 10, 10]);
    expect(at(500_001)).toEqual(["up to $1,000,000", 5, 10]);
    expect(at(1_000_000)).toEqual(["up to $1,000,000", 5, 10]);
    expect(at(2_000_000)).toEqual(["up to $2,000,000", 3, 7]);
    expect(at(2_000_001)).toEqual(["over $2,000,000", 2, 7]);
  });

  it("flag the broker rate against its band", async () => {
    const { federalBreaches } = await import("./federal");
    const g = DEFAULT_SETTINGS.mortgages;
    const big = { baseCents: 150_000_000, bankerFeeCents: null };
    expect(federalBreaches({ ...big, brokerRateBp: 700 }, g)).toEqual([]);
    expect(federalBreaches({ ...big, brokerRateBp: 750 }, g)).toEqual(["Broker rate 7.5% is above the federal maximum of 7% for mortgages up to $2,000,000"]);
    expect(federalBreaches({ baseCents: null, brokerRateBp: 2000, bankerFeeCents: null }, g)).toEqual([]);
  });
});

describe("allowance rule fitting", () => {
  const d = (day: number, h = 12) => new Date(Date.UTC(2026, 9, day, h));
  const events = [
    { kind: "origination" as const, at: d(2), loanCents: 50_000_000, label: "A" },
    { kind: "repayment" as const, at: d(9), grossCents: 1_000_000, principalCents: 900_000, label: "A #1" },
    { kind: "repayment" as const, at: d(16), grossCents: 1_000_000, principalCents: 900_000, label: "A #2" },
  ];

  it("identifies the rule that explains every reading", () => {
    // Truth: −1× loan at start, +4× principal per payment.
    const readings = [
      { id: "r0", at: d(1), balanceCents: 100_000_000 },
      { id: "r1", at: d(3), balanceCents: 50_000_000 },
      { id: "r2", at: d(10), balanceCents: 53_600_000 },
      { id: "r3", at: d(17), balanceCents: 57_200_000 },
    ];
    const fit = fitAllowance(readings, events);
    expect(fit.ranking[0].rule.id).toBe("o1-principal4");
    expect(fit.ranking[0].exact).toBe(3);
    expect(fit.conclusive).toBe(true);
  });

  it("is inconclusive with a single reading or no events in between", () => {
    expect(fitAllowance([{ id: "r", at: d(1), balanceCents: 1 }], events).conclusive).toBe(false);
    expect(fitAllowance([{ id: "a", at: d(20), balanceCents: 1 }, { id: "b", at: d(21), balanceCents: 1 }], events).conclusive).toBe(false);
  });

  it("projects the balance from the last reading", () => {
    const rule = ruleById("o1-gross4")!;
    const e = expectedBalance([{ id: "r", at: d(8), balanceCents: 10_000_000 }], events, rule, d(20))!;
    expect(e.balanceCents).toBe(10_000_000 + 2 * 4 * 1_000_000);
    expect(ALLOWANCE_RULES.length).toBeGreaterThan(8);
  });

  it("reads the game's sanction amount", () => {
    expect(sanctionFromStatus("SANCTIONED: The full loan amount x5 : 382010 has been deducted from the finance companies state federal allowance balance -- DEFAULTED")).toBe(38_201_000);
    expect(sanctionFromStatus("DEFAULTED: Too many missed payments (3).")).toBeNull();
  });
});

describe("identity across renumbered addresses", () => {
  it("matches former addresses and exact money", async () => {
    const { hasAddress, originationFits, withAlias } = await import("./identity");
    const m = { address: "112 West Mirror Drive", addressAliases: ["119 West Mirror Drive"] };
    expect(hasAddress(m, "119  west mirror drive ")).toBe(true);
    expect(hasAddress(m, "120 West Mirror Drive")).toBe(false);
    const t = { downPaymentCents: 3_000_000, brokerFeeCents: 1_000_000, agencyCommissionCents: 14_000_000, loanCents: 17_000_000 };
    expect(originationFits(t, { netInCents: 18_000_000, outCents: 17_000_000 })).toBe(true);
    expect(originationFits(t, { netInCents: 18_000_000, outCents: null })).toBe(true);
    expect(originationFits(t, { netInCents: 18_000_100, outCents: 17_000_000 })).toBe(false);
    expect(withAlias([], "112 West Mirror Drive", "119 West Mirror Drive")).toEqual(["119 West Mirror Drive"]);
    expect(withAlias(["119 West Mirror Drive"], "112 West Mirror Drive", "119 West Mirror Drive")).toHaveLength(1);
  });

  it("moves a mortgage to its new address and keeps the old ones", async () => {
    const { movedTo } = await import("./identity");
    expect(movedTo({ address: "112 North Rockford Dr", addressAliases: ["115 North Rockford Dr"] }, "113 North Rockford Dr")).toEqual({
      address: "113 North Rockford Dr",
      addressAliases: ["115 North Rockford Dr", "112 North Rockford Dr"],
    });
    // Back to a former number: it stops being a former one.
    expect(movedTo({ address: "113 North Rockford Dr", addressAliases: ["112 North Rockford Dr"] }, "112 North Rockford Dr")).toEqual({
      address: "112 North Rockford Dr",
      addressAliases: ["113 North Rockford Dr"],
    });
    expect(movedTo({ address: "112 North Rockford Dr", addressAliases: [] }, " 112 north rockford dr")).toBeNull();
  });
});

describe("linking repayments (addresses renumbered and reused, 2026-10-28)", () => {
  const at = (d: string) => new Date(`2026-10-${d}T12:00:00Z`);
  const mortgage = (id: string, buyer: number | null, address: string, aliases: string[] = [], extra: Partial<RepaymentCandidate> = {}) => ({
    id,
    address,
    addressAliases: aliases,
    buyerStateId: buyer,
    originatedAt: at("01"),
    status: "active" as const,
    paidGrossCents: [],
    ...extra,
  });
  const row = (payer: number | null, address: string | null, grossCents = 100, d = "24") => ({ address, payerStateId: payer, occurredAt: at(d), grossCents });
  const target = (r: ReturnType<typeof row>, ms: ReturnType<typeof mortgage>[]) => {
    const found = repaymentMortgage(r, ms);
    return found && { id: found.mortgage.id, by: found.by };
  };

  // A's house was once 115, now 112; B's house is 114 and has just become 115.
  const a = mortgage("a", 1001, "112 North Rockford Dr", ["115 North Rockford Dr"]);
  const b = mortgage("b", 1002, "114 North Rockford Dr");

  it("files a payment under the payer's mortgage, not the one that used to have the address", () => {
    expect(target(row(1002, "115 North Rockford Dr"), [a, b])).toEqual({ id: "b", by: "buyer" });
  });

  it("takes a buyer's payment under an address never seen before", () => {
    expect(target(row(1001, "113 North Rockford Dr"), [a, b])).toEqual({ id: "a", by: "buyer" });
  });

  it("still links by address, current or former, when the payer's mortgage has it", () => {
    expect(target(row(1001, "112 North Rockford Dr"), [a, b])).toEqual({ id: "a", by: "address" });
    expect(target(row(1001, "115 north rockford dr"), [a, b])).toEqual({ id: "a", by: "address" });
  });

  it("tells a buyer's two mortgages apart by the amount when the address is new", () => {
    const one = mortgage("one", 1003, "101 Elm St", [], { paidGrossCents: [500, 500] });
    const two = mortgage("two", 1003, "102 Elm St", [], { paidGrossCents: [900] });
    expect(target(row(1003, "201 Elm St", 900), [one, two])).toEqual({ id: "two", by: "buyer" });
    // Neither amount fits: left for a person.
    expect(target(row(1003, "201 Elm St", 700), [one, two])).toBeNull();
  });

  it("ignores the payer's finished mortgages and ones that started after the payment", () => {
    const done = mortgage("done", 1004, "101 Oak St", [], { status: "completed" });
    const later = mortgage("later", 1004, "102 Oak St", [], { originatedAt: at("26") });
    const now = mortgage("now", 1004, "103 Oak St");
    expect(target(row(1004, "999 Oak St"), [done, later, now])).toEqual({ id: "now", by: "buyer" });
  });

  it("falls back to the address when the payer has no mortgage on record (a house sold under mortgage)", () => {
    expect(target(row(2000, "114 North Rockford Dr"), [a, b])).toEqual({ id: "b", by: "address" });
    expect(target(row(null, "112 North Rockford Dr"), [a, b])).toEqual({ id: "a", by: "address" });
    expect(target(row(2000, "300 Nowhere Rd"), [a, b])).toBeNull();
  });
});

describe("company-funded mortgages", () => {
  it("are recognised from the tablet and from the money (103 Forum Dr, Apt 2I)", async () => {
    const { fundingOf, originationPattern } = await import("./identity");
    expect(fundingOf({ fedRateBp: null, federalInterestCents: null })).toBe("company");
    expect(fundingOf({ fedRateBp: 300, federalInterestCents: 1_861_400 })).toBe("state");
    const forum = { downPaymentCents: 2_704_600, brokerFeeCents: 184_000, agencyCommissionCents: 1_127_600, loanCents: 975_000 };
    // Bank: $30,162 in with $1,276 tax → $28,886 net; $36,796 to the State.
    expect(originationPattern(forum, { netInCents: 2_888_600, outCents: 3_679_600 })).toBe("company");
    // No fed-rate checks without a fed rate, and company-funded mortgages are exempt from the federal maximums.
    expect(mortgageGuidelines({ brokerRateBp: 1500, fedRateBp: null, ...forum }, { buyerHasOtherMortgage: false, funding: "company", originatedAt: null })).toEqual([]);
  });

  it("schedule has no federal interest", () => {
    const s = mortgageSchedule({ loanCents: 975_000, brokerInterestCents: 73_200, federalInterestCents: 0, instalments: 13, originatedAt: new Date("2026-10-02T17:36:52Z") });
    expect(s[0]).toMatchObject({ principalCents: 75_000, brokerInterestCents: 5_600, totalCents: 80_600 }); // "$806" weekly
    expect(s.reduce((a, r) => a + r.principalCents, 0)).toBe(975_000);
  });
});
