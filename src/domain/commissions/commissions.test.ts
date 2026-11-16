import { describe, expect, it } from "vitest";
import { calculateWeek } from "./calculate";
import { COMMISSION_START, isWeekKey, shiftWeek, weekKeyOf, weekRange, weeksSinceStart } from "./week";

describe("commission weeks (Monday 00:00 London)", () => {
  it("starts the scheme on Monday 12 Oct 2026 at midnight BST", () => {
    expect(COMMISSION_START.toISOString()).toBe("2026-10-11T23:00:00.000Z");
  });

  it("assigns instants to the London week, across the clocks going back", () => {
    expect(weekKeyOf(new Date("2026-10-11T22:59:59Z"))).toBe("2026-10-05"); // Sun 23:59 BST
    expect(weekKeyOf(new Date("2026-10-11T23:00:00Z"))).toBe("2026-10-12"); // Mon 00:00 BST
    const { from, to } = weekRange("2026-10-19"); // clocks go back on Sun 25 Oct
    expect(from.toISOString()).toBe("2026-10-18T23:00:00.000Z");
    expect(to.toISOString()).toBe("2026-10-26T00:00:00.000Z"); // Monday 00:00 GMT
  });

  it("validates and steps week keys", () => {
    expect(isWeekKey("2026-10-12")).toBe(true);
    expect(isWeekKey("2026-10-13")).toBe(false);
    expect(shiftWeek("2026-12-28", 1)).toBe("2027-01-04");
    expect(weeksSinceStart(new Date("2026-10-27T12:00:00Z"))).toEqual(["2026-10-12", "2026-10-19", "2026-10-26"]);
    expect(weeksSinceStart(new Date("2026-10-10T12:00:00Z"))).toEqual([]);
  });
});

describe("calculateWeek", () => {
  const at = new Date("2026-10-13T12:00:00Z");

  it("pays officers 50% of interest net of tax, and splits banker fees 20/30/50", () => {
    const c = calculateWeek({
      interest: [
        { txId: "t1", at, netCents: 1_000_00, loanId: "L1", officerStaffId: "jax", label: "Loan A" },
        { txId: "t2", at, netCents: 333_00, loanId: "L2", officerStaffId: "jax", label: "Loan B" },
        { txId: "t3", at, netCents: 101_00, loanId: "L3", officerStaffId: "cove", label: "Loan C" },
      ],
      // 117 Invention Ct: $55,151 fee arranged by Skyler.
      fees: [{ mortgageId: "M1", at, feeCents: 5_515_100, originatorStaffId: "skyler", label: "117 Invention Ct" }],
      roster: ["jax", "cove", "skyler"],
    });
    // Every share is whole dollars: $500 + $166.50 → $167; pool 30% of $55,151 = $16,545.30 → $16,545.
    expect(c.lines.find((l) => l.label === "Loan B")?.amountCents).toBe(16_700);
    expect(c.pool).toMatchObject({ totalCents: 1_654_500, members: 3, perPersonCents: 551_500, remainderCents: 0 });
    expect(c.totals.get("jax")).toBe(50_000 + 16_700 + 551_500);
    expect(c.totals.get("skyler")).toBe(1_103_000 + 551_500); // 20% of $55,151 = $11,030.20 → $11,030
    expect(c.lines.every((l) => l.amountCents % 100 === 0)).toBe(true);
    // Company: the rest of the fee.
    expect(c.companyShareCents).toBe(5_515_100 - 1_103_000 - 1_654_500);
    expect(c.problems).toEqual([]);
  });

  it("reports earnings with no officer and fees not yet known", () => {
    const c = calculateWeek({
      interest: [{ txId: "t1", at, netCents: 50_00, loanId: "L1", officerStaffId: null, label: "Loan A" }],
      fees: [{ mortgageId: "M1", at, feeCents: null, originatorStaffId: "skyler", label: "103 Forum Dr" }],
      roster: [],
    });
    expect(c.problems.map((p) => p.kind)).toEqual(["no_officer", "unknown_fee"]);
    expect(c.totals.size).toBe(0);
  });

  it("keeps the whole pool for the company when nobody is confirmed", () => {
    const c = calculateWeek({ interest: [], fees: [{ mortgageId: "M", at, feeCents: 1_000_000, originatorStaffId: "a", label: "x" }], roster: [] });
    expect(c.pool.remainderCents).toBe(300_000);
    expect(c.companyShareCents).toBe(800_000);
  });
});

describe("old commission payments", () => {
  it("reads the items they paid for", async () => {
    const { parseCommissionItems } = await import("./legacy");
    const items = parseCommissionItems(
      "Employee Pay: Commission Pay: Hollis Everhart  Sep 17, 2026 Â· interest  $203   Oakley Greystone  Sep 13, 2026 · early interest  $129   Frankie O'Neil-Smith  Sep 24, 2026 · interest  $1,816",
    );
    expect(items).toEqual([
      { name: "Hollis Everhart", year: 2026, month: 9, day: 17, kind: "interest", amountCents: 20_300 },
      { name: "Oakley Greystone", year: 2026, month: 9, day: 13, kind: "early_interest", amountCents: 12_900 },
      { name: "Frankie O'Neil-Smith", year: 2026, month: 9, day: 24, kind: "interest", amountCents: 181_600 },
    ]);
    expect(parseCommissionItems("Employee Pay: Commission Pay: 50% of Bank Fee - 117 Invention Ct")).toEqual([]);
  });

  it("matches receipts already paid by borrower and day (one item per receipt, a day of slack)", async () => {
    const { alreadyPaid } = await import("./legacy");
    const r = (id: string, day: number, commission: number, name = "Frankie Elsworth") => ({ id, borrowerName: name, year: 2026, month: 9, day, kind: "interest" as const, commissionCents: commission });
    const items = [
      { name: "Frankie Elsworth", year: 2026, month: 9, day: 17, kind: "interest" as const, amountCents: 81_600 },
      { name: "Frankie Elsworth", year: 2026, month: 9, day: 24, kind: "interest" as const, amountCents: 81_600 },
    ];
    const paid = alreadyPaid([r("a", 17, 81_550), r("b", 25, 81_700), r("c", 1, 81_600), r("d", 17, 81_600, "Someone Else")], items);
    expect([...paid.keys()].sort()).toEqual(["a", "b"]);
    expect(paid.get("b")?.day).toBe(24);
  });
});

describe("settings", () => {
  it("fills in defaults for anything a stored version lacks, and lists changes", async () => {
    const { DEFAULT_SETTINGS, resolveSettings, settingsChanges, commissionRates } = await import("@/domain/settings");
    expect(resolveSettings({ commission: { mortgagePoolPct: 25 } }).commission).toEqual({ loanInterestPct: 50, mortgageOriginatorPct: 20, mortgagePoolPct: 25 });
    expect(resolveSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(commissionRates(DEFAULT_SETTINGS)).toEqual({ loanInterest: 0.5, mortgageOriginator: 0.2, mortgagePool: 0.3 });
    expect(settingsChanges(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, loans: { ...DEFAULT_SETTINGS.loans, writeOffAfterDays: 14 } })).toEqual([{ path: "loans.writeOffAfterDays", from: 28, to: 14 }]);
  });

  it("mortgage guidelines follow the configured federal bands", async () => {
    const { mortgageGuidelines } = await import("@/domain/mortgages/schedule");
    const { DEFAULT_SETTINGS, settingsSchema } = await import("@/domain/settings");
    const m = { brokerRateBp: 650, fedRateBp: 1200, brokerFeeCents: null, downPaymentCents: 10_000_000, loanCents: 90_000_000 };
    const opts = { buyerHasOtherMortgage: false, funding: "state" as const, originatedAt: null };
    expect(mortgageGuidelines(m, opts)).toEqual([]);
    const tighter = { ...DEFAULT_SETTINGS.mortgages, federalBand2BrokerRateMaxPct: 6 };
    expect(mortgageGuidelines(m, opts, tighter)).toEqual([
      { level: "breach", rule: "federal_maximum", text: "Broker rate 6.5% is above the federal maximum of 6% for mortgages up to $1,000,000" },
    ]);
    // Bands must climb.
    const bad = { ...DEFAULT_SETTINGS, mortgages: { ...DEFAULT_SETTINGS.mortgages, federalBand2UpToDollars: 400_000 } };
    expect(settingsSchema.safeParse(bad).success).toBe(false);
  });
});
