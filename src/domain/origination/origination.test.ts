import { describe, expect, it } from "vitest";
import { contractDate, renderLoanContract } from "./contracts";
import { contractDifferences, offerChecks, offerFigures, suggestRate, suggestedDefaultFee } from "./loan-offer";
import { federalMaximumBreaches, instalmentsFor, quoteChecks, quoteDifferences, quoteMortgage } from "./mortgage-quote";

const $ = (d: number) => d * 100;

describe("quoteMortgage reproduces the tablet", () => {
  it("117 Invention Ct (to the dollar)", () => {
    const q = quoteMortgage({ priceCents: $(733_856), agencyCommissionCents: $(44_470), downPaymentPct: 10, termMonths: 12, fedRatePct: 3, brokerRatePct: 6, bankerFeePct: 8, primaryResidence: true, companyFunded: false });
    expect(q).toMatchObject({
      downPaymentCents: $(68_939),
      loanCents: $(620_447),
      instalments: 52,
      bankerFeeCents: $(55_151),
      brokerInterestCents: $(37_227),
      federalInterestCents: $(18_614),
      weeklyCents: $(13_003),
      taxCents: $(34_470),
      dueAtSigningCents: $(203_030),
      afterTaxCents: $(768_326),
    });
  });

  it("110 Ineseno Road, and the payment counts on record", () => {
    const q = quoteMortgage({ priceCents: $(1_367_342), agencyCommissionCents: $(74_636), downPaymentPct: 10, termMonths: 12, fedRatePct: 3, brokerRatePct: 2.5, bankerFeePct: 10, primaryResidence: true, companyFunded: false });
    expect(q).toMatchObject({ downPaymentCents: $(129_271), loanCents: $(1_163_435), bankerFeeCents: $(129_271), taxCents: $(64_636), dueAtSigningCents: $(397_814) });
    expect([1, 2, 3, 6, 7, 8, 9, 12].map(instalmentsFor)).toEqual([5, 9, 13, 26, 31, 35, 39, 52]);
  });

  it("checks the handbook", () => {
    const input = { priceCents: $(500_000), agencyCommissionCents: $(30_000), downPaymentPct: 8, termMonths: 6, fedRatePct: 3, brokerRatePct: 8, bankerFeePct: 5, primaryResidence: false, companyFunded: false };
    const flags = quoteChecks(input, quoteMortgage(input));
    expect(flags.map((f) => f.text)).toEqual([
      "Not the buyer’s primary residence: the fed rate must be at least 10%",
      "The tablet needs a down payment of at least 10%",
    ]);
    // Neither blocks saving: only the federal maximums do.
    expect(federalMaximumBreaches(flags)).toEqual([]);
  });

  it("blocks quotes over the federal maximums (owner, 2026-10-15)", () => {
    // 117 Invention Ct: $689,386 down payment + loan → the band up to $1,000,000 (5% fee, 10% broker).
    const input = { priceCents: $(733_856), agencyCommissionCents: $(44_470), downPaymentPct: 10, termMonths: 12, fedRatePct: 3, brokerRatePct: 10, bankerFeePct: 5, primaryResidence: true, companyFunded: false };
    const at = (over: Partial<typeof input>) => {
      const i = { ...input, ...over };
      return federalMaximumBreaches(quoteChecks(i, quoteMortgage(i))).map((f) => f.text);
    };
    expect(at({})).toEqual([]);
    expect(at({ bankerFeePct: 8, brokerRatePct: 10.5 })).toEqual([
      "Banker fee 8% is above the federal maximum of 5% for mortgages up to $1,000,000",
      "Broker rate 10.5% is above the federal maximum of 10% for mortgages up to $1,000,000",
    ]);
    // The fee as typed is what counts, even when the tablet would round it to the same dollar.
    expect(at({ bankerFeePct: 5.01 })).toHaveLength(1);
    // Company-funded mortgages are exempt, and have no fed rate to check.
    expect(at({ bankerFeePct: 8, brokerRatePct: 12, companyFunded: true })).toEqual([]);
    expect(quoteChecks({ ...input, companyFunded: true, fedRatePct: 0 }, quoteMortgage({ ...input, companyFunded: true }))).toEqual([]);
    expect(quoteMortgage({ ...input, companyFunded: true }).federalInterestCents).toBe(0);
    // A quote whose mortgage was arranged before the rules started is judged by the rules then.
    const before = { ...input, bankerFeePct: 8 };
    expect(federalMaximumBreaches(quoteChecks(before, quoteMortgage(before), undefined, new Date("2026-10-08T12:00:00Z")))).toEqual([]);
  });
});

describe("loan offers", () => {
  // The property template's example loan: $130,000 at 15% over 24 weeks from 29 Sept 2026.
  const example = { amountCents: $(130_000), ratePct: 15, stateRatePct: 1, weeks: 24, startsOn: new Date("2026-09-29T12:00:00Z"), collateralValueCents: $(200_000), weeklyIncomeCents: $(20_000) };

  it("works out the contract's figures", () => {
    const f = offerFigures(example);
    expect(f).toMatchObject({ totalCents: $(149_500), interestCents: $(19_500), weeklyCents: $(6_229), lastCents: $(6_233), stateShareCents: $(1_300), littsEarnsCents: $(18_200) });
    expect(contractDate(f.schedule[0].dueOn)).toBe("6th October 2026");
    expect(f.schedule.reduce((s, r) => s + r.cents, 0)).toBe($(149_500));
    expect(Math.round(f.ltvPct!)).toBe(65);
    expect(Math.round(f.paymentToIncomePct!)).toBe(31);
  });

  it("suggests a rate with its reasons, within the range", () => {
    const s = suggestRate("property", example, { repaid: 0, wentBad: 0, open: 0, doNotLend: false });
    expect(s.ratePct).toBeGreaterThanOrEqual(10);
    expect(s.ratePct).toBeLessThanOrEqual(25);
    expect(s.reasons.map((r) => r.text)).toEqual(expect.arrayContaining(["Long term (24 weeks)", "First loan with Litt’s", "Large loan ($100,000 or more)"]));
    const risky = suggestRate("general", { ...example, collateralValueCents: null, weeklyIncomeCents: $(5_000) }, { repaid: 0, wentBad: 2, open: 1, doNotLend: false });
    expect(risky).toMatchObject({ ratePct: 25, clamped: true });
  });

  it("flags what the handbook asks for", () => {
    const f = offerFigures({ ...example, ratePct: 30, stateRatePct: 15 });
    const texts = offerChecks("property", { ...example, ratePct: 30, stateRatePct: 15, defaultFeePerDayCents: 0 }, f).map((x) => x.text);
    expect(texts).toEqual(
      expect.arrayContaining([expect.stringMatching(/needs Executive Management sign-off/), expect.stringMatching(/Enter 1% as the State rate/), expect.stringMatching(/Set a Defaulted Account Fee/)]),
    );
    expect(suggestedDefaultFee($(130_000))).toBe($(1_000));
  });
});

describe("contracts", () => {
  const schedule = offerFigures({ amountCents: $(130_000), ratePct: 15, stateRatePct: 1, weeks: 24, startsOn: new Date("2026-09-29T12:00:00Z"), collateralValueCents: null, weeklyIncomeCents: null }).schedule;
  const base = {
    date: new Date("2026-09-29T12:00:00Z"),
    borrowerName: "Avery Lane",
    borrowerStateId: 40001,
    amountCents: $(130_000),
    ratePct: 15,
    totalCents: $(149_500),
    weeks: 24,
    schedule,
    purpose: null,
    defaultFeePerDayCents: $(1_000),
    purchaseDays: 3,
    detailsHours: 72,
    extraHours: 24,
    defaultAfterDays: 7,
    representativeName: "Kieran Jones",
    representativeStateId: 3454,
  };

  it("fills the property template like the owner's example", () => {
    const text = renderLoanContract({ ...base, kind: "property", collateral: "103 South Rockford Dr" });
    for (const line of [
      "LITT'S LOANS PROPERTY LOAN AGREEMENT",
      'This Property Loan Agreement ("Agreement") is made and entered into on 29th September 2026, by and between:',
      'Avery Lane [40001] ("Borrower").',
      "Loan Amount: $130,000",
      "Interest Rate: 15% interest on loan amount",
      "Total Repayment Amount: $149,500",
      "Loan Term: 24 Weeks",
      "Repayment Schedule: $6,229 a week starting 6th October 2026 (final payment $6,233 on 16th March 2027)",
      "Property Details: 103 South Rockford Dr",
      "The Defaulted Account Fee for this loan is $1,000 per day that the loan remains in default.",
      "LENDER: Litt's Loans Representative: Kieran Jones [3454]",
      "11. ACKNOWLEDGEMENT & SIGNATURES",
    ])
      expect(text).toContain(line);
  });

  it("lists every payment on the vehicle agreement, and drafts a personal one", () => {
    const vehicle = renderLoanContract({ ...base, kind: "vehicle", collateral: "Bravado Buffalo STX" });
    expect(vehicle).toContain("Make & Model: Bravado Buffalo STX");
    expect(vehicle).toContain("6th October 2026 — $6,229");
    expect(vehicle).toContain("Vehicle Information: Failure to send vehicle information as specified in section 3.");
    const personal = renderLoanContract({ ...base, kind: "general", collateral: null, purpose: "Business stock" });
    expect(personal).toContain("LITT'S LOANS PERSONAL LOAN AGREEMENT");
    expect(personal).toContain("The Borrower states that the loan will be used for: Business stock.");
    expect(personal).toContain("This loan is unsecured");
    expect(personal).not.toContain("Repossession of pledged collateral.");
  });
});

describe("comparing what the game recorded with what was agreed", () => {
  it("spots rates typed the wrong way round on a phone card", () => {
    const contract = { amountCents: $(50_000), rateBp: 1500, stateRateBp: 100, weeks: 8 };
    expect(contractDifferences(contract, { principalCents: $(50_000), brokerRateBp: 1500, stateRateBp: 100, instalments: 8 })).toEqual([]);
    expect(contractDifferences(contract, { principalCents: $(50_000), brokerRateBp: 100, stateRateBp: 1500, instalments: 8 })).toHaveLength(2);
    // A loan whose card hasn't been pasted yet has no terms to compare.
    expect(contractDifferences(contract, { principalCents: $(50_000), brokerRateBp: null, stateRateBp: null, instalments: null })).toEqual([]);
  });

  it("compares a sale agreement with its quote", () => {
    const q = quoteMortgage({ priceCents: $(733_856), agencyCommissionCents: $(44_470), downPaymentPct: 10, termMonths: 12, fedRatePct: 3, brokerRatePct: 6, bankerFeePct: 8, primaryResidence: true, companyFunded: false });
    const agreed = { downPaymentCents: $(68_939), loanCents: $(620_447), brokerFeeCents: $(55_151), brokerRateBp: 600, fedRateBp: 300, instalments: 52 };
    expect(quoteDifferences({ ...q, brokerRateBp: 600, fedRateBp: 300 }, agreed)).toEqual([]);
    expect(quoteDifferences({ ...q, brokerRateBp: 600, fedRateBp: 300 }, { ...agreed, brokerRateBp: 650, brokerFeeCents: $(60_000) })).toEqual([
      "Banker fee is $60,000 on the agreement, $55,151 in the quote",
      "Broker rate is 6.5% on the agreement, 6% in the quote",
    ]);
  });
});
