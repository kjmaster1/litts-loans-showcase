import { zonedMidnight } from "@/lib/company-time";
import { formatCents } from "@/lib/format";
import { percentOfCents } from "@/lib/money";
import type { Funding } from "@/domain/mortgages/identity";
import type { Settings } from "@/domain/settings";

/**
 * Federal maximums for State-funded mortgages (owner, 2026-10-15; research/17). A mortgage's band is
 * set by its down payment + loan (the banker fee's basis), and the whole mortgage uses that band's
 * maximum banker fee and broker rate — "up to" includes the amount itself. Company-funded mortgages
 * and mortgages arranged before the rules started are exempt. Quotes over a maximum can't be saved;
 * a tablet agreement over one is recorded (the money has moved) and flagged as a breach. Pure.
 */

export const FEDERAL_MAXIMUMS_FROM = zonedMidnight(2026, 10, 15);

export type FederalBand = {
  /** Upper end of the band, inclusive; null for the top band. */
  upToCents: number | null;
  /** The band above the previous one's end (for "over $2,000,000"). */
  overCents: number | null;
  bankerFeeMaxPct: number;
  brokerRateMaxPct: number;
};

export function federalBands(g: Settings["mortgages"]): FederalBand[] {
  const ends = [g.federalBand1UpToDollars, g.federalBand2UpToDollars, g.federalBand3UpToDollars].map((d) => d * 100);
  const fees = [g.federalBand1BankerFeeMaxPct, g.federalBand2BankerFeeMaxPct, g.federalBand3BankerFeeMaxPct, g.federalBand4BankerFeeMaxPct];
  const rates = [g.federalBand1BrokerRateMaxPct, g.federalBand2BrokerRateMaxPct, g.federalBand3BrokerRateMaxPct, g.federalBand4BrokerRateMaxPct];
  return fees.map((fee, i) => ({ upToCents: ends[i] ?? null, overCents: i === 3 ? ends[2] : null, bankerFeeMaxPct: fee, brokerRateMaxPct: rates[i] }));
}

/** The band for a down payment + loan amount. */
export function federalBandFor(baseCents: number, g: Settings["mortgages"]): FederalBand {
  const bands = federalBands(g);
  return bands.find((b) => b.upToCents !== null && baseCents <= b.upToCents) ?? bands[bands.length - 1];
}

export function bandLabel(b: FederalBand): string {
  return b.upToCents !== null ? `up to ${formatCents(b.upToCents)}` : `over ${formatCents(b.overCents ?? 0)}`;
}

/** Whether the maximums apply: State-funded, arranged on or after the start (unknown date = new). */
export function federalMaximumsApply(m: { funding: Funding; originatedAt: Date | null }): boolean {
  return m.funding === "state" && (m.originatedAt === null || m.originatedAt >= FEDERAL_MAXIMUMS_FROM);
}

export type FederalTerms = {
  /** Down payment + loan. */
  baseCents: number | null;
  brokerRateBp: number | null;
  bankerFeeCents: number | null;
  /** The banker fee as typed (quotes): checked exactly, before the tablet rounds it up to whole dollars. */
  bankerFeeBp?: number;
};

/** Breaches of the band's maximums (empty when within them or when the size isn't known). */
export function federalBreaches(t: FederalTerms, g: Settings["mortgages"]): string[] {
  if (t.baseCents === null || t.baseCents <= 0) return [];
  const band = federalBandFor(t.baseCents, g);
  const where = `for mortgages ${bandLabel(band)}`;
  const out: string[] = [];
  const maxFeeBp = Math.round(band.bankerFeeMaxPct * 100);
  if (t.bankerFeeBp !== undefined) {
    if (t.bankerFeeBp > maxFeeBp) out.push(`Banker fee ${t.bankerFeeBp / 100}% is above the federal maximum of ${band.bankerFeeMaxPct}% ${where}`);
  } else if (t.bankerFeeCents !== null) {
    // The tablet rounds the fee up to whole dollars, so the most it can be is the maximum rounded up.
    const maxCents = percentOfCents(t.baseCents, band.bankerFeeMaxPct, "up");
    if (t.bankerFeeCents > maxCents) {
      const pct = Math.round((t.bankerFeeCents / t.baseCents) * 1000) / 10;
      out.push(`Banker fee ${formatCents(t.bankerFeeCents)} (${pct}%) is above the federal maximum of ${band.bankerFeeMaxPct}% (${formatCents(maxCents)}) ${where}`);
    }
  }
  if (t.brokerRateBp !== null && t.brokerRateBp > Math.round(band.brokerRateMaxPct * 100)) {
    out.push(`Broker rate ${t.brokerRateBp / 100}% is above the federal maximum of ${band.brokerRateMaxPct}% ${where}`);
  }
  return out;
}
