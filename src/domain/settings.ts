import { z } from "zod";

/**
 * Company settings (SPEC §2 "Settings", research/11). Pure: defaults, validation
 * and the shape stored in each `company_setting` version.
 */

const pct = z.number().min(0).max(100);
const dollars = z.number().int().min(1).max(1_000_000_000);

export const settingsSchema = z
  .object({
    commission: z.object({
      /** % of loan interest received (net of tax) paid to the loan's officer. */
      loanInterestPct: pct,
      /** % of a mortgage banker fee paid to the officer who arranged it. */
      mortgageOriginatorPct: pct,
      /** % of a mortgage banker fee shared equally by the week's pool. */
      mortgagePoolPct: pct,
    }),
    loans: z.object({
      /** Days after default before a write-off is available. */
      writeOffAfterDays: z.number().int().min(0).max(365),
      /** Handbook §4B: rates officers may offer without Executive sign-off. */
      rateMinPct: pct,
      rateMaxPct: pct,
      /** The State interest rate officers type in game (owner: always 1%). */
      stateRatePct: pct,
      /** Weekly payment above this share of the borrower's stated weekly income is a warning. */
      maxPaymentToIncomePct: pct,
      /** Suggested Defaulted Account Fee per day, % of the loan (the officer chooses). */
      defaultFeePerDayPct: pct,
      /** Contract terms (templates): days to buy, hours to send details, extra hours, days late before default. */
      purchaseDays: z.number().int().min(1).max(30),
      detailsHours: z.number().int().min(1).max(720),
      extraHours: z.number().int().min(1).max(720),
      defaultAfterDays: z.number().int().min(1).max(60),
    }),
    mortgages: z.object({
      /**
       * Federal maximums for State-funded mortgages (owner, 2026-10-15): bands of down payment + loan,
       * each with a maximum banker fee and broker rate; band 4 is everything above band 3.
       * Quotes over them can't be saved (`domain/mortgages/federal.ts`).
       */
      federalBand1UpToDollars: dollars,
      federalBand1BankerFeeMaxPct: pct,
      federalBand1BrokerRateMaxPct: pct,
      federalBand2UpToDollars: dollars,
      federalBand2BankerFeeMaxPct: pct,
      federalBand2BrokerRateMaxPct: pct,
      federalBand3UpToDollars: dollars,
      federalBand3BankerFeeMaxPct: pct,
      federalBand3BrokerRateMaxPct: pct,
      federalBand4BankerFeeMaxPct: pct,
      federalBand4BrokerRateMaxPct: pct,
      /** Down payment + loan above this needs an executive's approval (owner, 2026-10-15; `domain/mortgages/approval.ts`). */
      executiveApprovalAboveDollars: dollars,
      /** A quote that fits the State allowance but leaves less than this counts as Tight. */
      allowanceCushionDollars: dollars,
      /** State minimum fed rate (breach below). */
      fedRateMinPct: pct,
      /** Fed rate expected when the buyer already holds a Litt's mortgage (warning below). */
      fedRateSecondHomeMinPct: pct,
      /** Handbook §4A: start negotiations at this broker rate. */
      brokerRateStartPct: pct,
      /** The tablet's minimum down payment, % of down payment + loan. */
      downPaymentMinPct: pct,
    }),
    legal: z.object({
      /** Attorney & filing fee paid to the lawyer for each case handed over (owner, 2026-11-10: $2,750 with the current lawyer). */
      caseFeeDollars: dollars,
    }),
  })
  .superRefine((s, ctx) => {
    if (s.commission.mortgageOriginatorPct + s.commission.mortgagePoolPct > 100) {
      ctx.addIssue({ code: "custom", path: ["commission", "mortgagePoolPct"], message: "Originator and pool can't add up to more than 100% of the fee." });
    }
    const m = s.mortgages;
    if (m.federalBand2UpToDollars <= m.federalBand1UpToDollars) {
      ctx.addIssue({ code: "custom", path: ["mortgages", "federalBand2UpToDollars"], message: "Each federal band must end above the one before it." });
    }
    if (m.federalBand3UpToDollars <= m.federalBand2UpToDollars) {
      ctx.addIssue({ code: "custom", path: ["mortgages", "federalBand3UpToDollars"], message: "Each federal band must end above the one before it." });
    }
    if (s.loans.rateMinPct > s.loans.rateMaxPct) {
      ctx.addIssue({ code: "custom", path: ["loans", "rateMaxPct"], message: "The loan rate range's top must be at least its bottom." });
    }
  });

export type Settings = z.infer<typeof settingsSchema>;

/** What the app used before settings existed (research/03, 04, 08). */
export const DEFAULT_SETTINGS: Settings = {
  commission: { loanInterestPct: 50, mortgageOriginatorPct: 20, mortgagePoolPct: 30 },
  loans: {
    writeOffAfterDays: 28,
    rateMinPct: 10,
    rateMaxPct: 25,
    stateRatePct: 1,
    maxPaymentToIncomePct: 40,
    defaultFeePerDayPct: 0.75,
    purchaseDays: 3,
    detailsHours: 72,
    extraHours: 24,
    defaultAfterDays: 7,
  },
  mortgages: {
    // Federal maximums (owner, 2026-10-15). They replace the handbook's 7.5–15% banker fee,
    // 7.5% State broker maximum and 3–7% company broker range.
    federalBand1UpToDollars: 500_000,
    federalBand1BankerFeeMaxPct: 10,
    federalBand1BrokerRateMaxPct: 10,
    federalBand2UpToDollars: 1_000_000,
    federalBand2BankerFeeMaxPct: 5,
    federalBand2BrokerRateMaxPct: 10,
    federalBand3UpToDollars: 2_000_000,
    federalBand3BankerFeeMaxPct: 3,
    federalBand3BrokerRateMaxPct: 7,
    federalBand4BankerFeeMaxPct: 2,
    federalBand4BrokerRateMaxPct: 7,
    executiveApprovalAboveDollars: 1_000_000,
    allowanceCushionDollars: 100_000,
    fedRateMinPct: 3,
    fedRateSecondHomeMinPct: 10,
    brokerRateStartPct: 6,
    downPaymentMinPct: 10,
  },
  legal: { caseFeeDollars: 2750 },
};

/** A stored version, filled in with defaults for anything added since it was saved. */
export function resolveSettings(stored: unknown): Settings {
  const s = (stored ?? {}) as Partial<Settings>;
  const merged = {
    commission: { ...DEFAULT_SETTINGS.commission, ...s.commission },
    loans: { ...DEFAULT_SETTINGS.loans, ...s.loans },
    mortgages: { ...DEFAULT_SETTINGS.mortgages, ...s.mortgages },
    legal: { ...DEFAULT_SETTINGS.legal, ...s.legal },
  };
  const parsed = settingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

/** The commission engine's rates (fractions). */
export function commissionRates(s: Settings) {
  return { loanInterest: s.commission.loanInterestPct / 100, mortgageOriginator: s.commission.mortgageOriginatorPct / 100, mortgagePool: s.commission.mortgagePoolPct / 100 };
}

/** Field-by-field differences between two versions, for the audit trail and history. */
export function settingsChanges(before: Settings, after: Settings): { path: string; from: number; to: number }[] {
  const out: { path: string; from: number; to: number }[] = [];
  for (const group of ["commission", "loans", "mortgages", "legal"] as const) {
    const a = before[group] as Record<string, number>;
    const b = after[group] as Record<string, number>;
    for (const k of Object.keys(b)) if (a[k] !== b[k]) out.push({ path: `${group}.${k}`, from: a[k], to: b[k] });
  }
  return out;
}

export const SETTING_LABELS: Record<string, string> = {
  "commission.loanInterestPct": "Loan interest to the officer",
  "commission.mortgageOriginatorPct": "Banker fee to the originator",
  "commission.mortgagePoolPct": "Banker fee to the weekly pool",
  "loans.writeOffAfterDays": "Write-off available after (days)",
  "loans.rateMinPct": "Loan rate: range from",
  "loans.rateMaxPct": "Loan rate: range to",
  "loans.stateRatePct": "State rate to enter on loans",
  "loans.maxPaymentToIncomePct": "Weekly payment: most of weekly income",
  "loans.defaultFeePerDayPct": "Defaulted Account Fee suggestion (per day)",
  "legal.caseFeeDollars": "Attorney & filing fee per case ($)",
  "loans.purchaseDays": "Contract: days to buy the vehicle/property",
  "loans.detailsHours": "Contract: hours to send its details",
  "loans.extraHours": "Contract: extra hours before default",
  "loans.defaultAfterDays": "Contract: days late before default",
  "mortgages.brokerRateStartPct": "Broker rate: start negotiations at",
  "mortgages.downPaymentMinPct": "Down payment: minimum",
  "mortgages.federalBand1UpToDollars": "Federal band 1: up to ($)",
  "mortgages.federalBand1BankerFeeMaxPct": "Federal band 1: banker fee maximum",
  "mortgages.federalBand1BrokerRateMaxPct": "Federal band 1: broker rate maximum",
  "mortgages.federalBand2UpToDollars": "Federal band 2: up to ($)",
  "mortgages.federalBand2BankerFeeMaxPct": "Federal band 2: banker fee maximum",
  "mortgages.federalBand2BrokerRateMaxPct": "Federal band 2: broker rate maximum",
  "mortgages.federalBand3UpToDollars": "Federal band 3: up to ($)",
  "mortgages.federalBand3BankerFeeMaxPct": "Federal band 3: banker fee maximum",
  "mortgages.federalBand3BrokerRateMaxPct": "Federal band 3: broker rate maximum",
  "mortgages.federalBand4BankerFeeMaxPct": "Federal band 4 (above band 3): banker fee maximum",
  "mortgages.federalBand4BrokerRateMaxPct": "Federal band 4 (above band 3): broker rate maximum",
  "mortgages.executiveApprovalAboveDollars": "Executive approval: down payment + loan above ($)",
  "mortgages.allowanceCushionDollars": "State allowance: cushion before a quote counts as Tight ($)",
  "mortgages.fedRateMinPct": "Fed rate: State minimum",
  "mortgages.fedRateSecondHomeMinPct": "Fed rate: buyer's second property",
};
