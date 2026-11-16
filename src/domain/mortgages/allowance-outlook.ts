/**
 * State allowance outlook (docs/research/19 §2). Pure.
 *
 * Projects the State's mortgage allowance forward from the latest reading, so officers can see whether a quote fits
 * on its signing day. It uses whichever allowance rule is adopted (or the conclusive best fit); on production data
 * (2026-10-19) that is `o1-principal4`: −1× the loan when a mortgage starts, +4× the principal of each repayment
 * (13 of 16 intervals exact; the misses were a one-off State top-up and a repayment credited minutes late). With no
 * rule, no repayments are projected and originations still take 1× the loan (`NO_RULE`).
 *
 * Each repayment is counted exactly once. Bank data (known events) and readings arrive at different times, so:
 * - known events after the reading are applied with the rule;
 * - expected repayments are projected only from `anchor = max(reading, end of bank data)`: anything due before it is
 *   already in the reading or in the bank;
 * - those due between the anchor and now (likely paid in game, not imported yet) are part of "allowance now".
 *
 * Repayments follow the game's clock: each instalment is due 7 days after the previous repayment (or after the
 * start), not on the contract's dates. A mortgage is "behind" when an instalment was due more than `BEHIND_GRACE_MS`
 * before the end of the bank data with no repayment for it; its repayments are left out. One due within the grace
 * period is counted just after the end of the bank data instead. Only confirmed, State-funded quotes draw on the
 * allowance: at their signing time, or now when that has passed unsigned; a quote marked signed in game counts like a
 * mortgage that has started (only if signed after the reading, which would otherwise already include it). Drafts
 * are what-ifs and never change the line. Every derived amount is whole dollars.
 */

import { wholeDollars } from "@/lib/money";
import { effect, type AllowanceEvent, type AllowanceRule } from "./allowance";

export const NO_RULE: AllowanceRule = {
  id: "none",
  label: "No allowance rule adopted",
  originationMultiple: 1,
  repaymentBasis: "principal",
  repaymentMultiple: 0,
};

export type OutlookInstalment = { principalCents: number; totalCents: number };

export type OutlookMortgage = {
  id: string;
  /** null = the viewer may not see it (the server fills it in). */
  label: string | null;
  status: "active" | "completed" | "defaulted";
  originatedAt: Date;
  /** From `mortgageSchedule`. */
  instalments: OutlookInstalment[];
  /** Bank repayments, ascending. */
  paidAt: Date[];
};

export type OutlookQuote = {
  id: string;
  number: number;
  address: string;
  officerStaffId: string;
  status: "draft" | "confirmed";
  companyFunded: boolean;
  loanCents: number;
  /** From the quote's mortgage schedule. */
  instalments: OutlookInstalment[];
  expectedSigningAt: Date | null;
  confirmedAt: Date | null;
  signedAt: Date | null;
};

export type OutlookInput = {
  now: Date;
  reading: { at: Date; balanceCents: number };
  bankTo: Date | null;
  rule: AllowanceRule | null;
  /** Bank-derived, as `getAllowanceView` builds them. */
  knownEvents: AllowanceEvent[];
  /** State-funded only. */
  mortgages: OutlookMortgage[];
  /** Live quotes (draft and confirmed). */
  quotes: OutlookQuote[];
  cushionCents: number;
};

export type Verdict = "fits" | "tight" | "short";

export type OutlookStep = {
  at: Date;
  kind: "repayment" | "signing";
  deltaCents: number;
  balanceCents: number;
  label: string | null;
  quoteNumber: number | null;
};

export type QuoteOutlook = {
  quoteId: string;
  number: number;
  signingAt: Date;
  passed: boolean;
  beforeCents: number;
  afterCents: number;
  verdict: Verdict;
  /** Drafts that are Short only; null = not within 60 days of the signing. */
  fitsFrom: Date | null;
};

export type AllowanceOutlook = {
  rule: AllowanceRule;
  ruleSource: "adopted" | "best_fit" | "none";
  readingAt: Date;
  bankTo: Date | null;
  bankStale: boolean;
  nowCents: number;
  horizon: Date;
  steps: OutlookStep[];
  /** Steps up to the later of the horizon and 60 days from now: what the quote form measures a signing against. */
  lineSteps: OutlookStep[];
  endCents: number;
  lowest: { at: Date; balanceCents: number; quoteNumber: number | null };
  behind: number;
  /** Signing order. */
  confirmed: QuoteOutlook[];
  /** Drafts with a signing time, each as a what-if on its own. */
  drafts: QuoteOutlook[];
};

/** The working behind a confirmation: `before = nowCents + repayments.cents − signings.cents`. */
export type ConfirmPreview = {
  nowCents: number;
  /** Expected repayments before the signing. */
  repayments: { count: number; cents: number };
  /** Confirmed signings before this one; `cents` is what they take. */
  signings: { numbers: number[]; cents: number };
  quote: QuoteOutlook;
  /** Confirmed quotes that fit without this one and would be short with it. */
  knockOn: { quoteId: string; number: number; officerStaffId: string; shortByCents: number }[];
};

/**
 * A confirmation's working as shown to staff: the rule it was worked out with, and each quote it would push short
 * named by its address, signing time and officer (every originator sees every quote; never a mortgage).
 */
export type ConfirmView = Omit<ConfirmPreview, "knockOn"> & {
  rule: { label: string; source: AllowanceOutlook["ruleSource"] };
  /** The cushion setting: a signing that leaves less than this is Tight. */
  cushionCents: number;
  knockOn: { number: number; address: string; signingAt: Date | null; officerName: string | null; yours: boolean; shortByCents: number }[];
};

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
/**
 * How late an instalment may be at the end of the bank data before its mortgage counts as behind (owner, 2026-10-20):
 * the game's due times drift, so a bank export taken just after one shouldn't drop the mortgage from the projection.
 */
export const BEHIND_GRACE_MS = 2 * HOUR_MS;
const HORIZON_MS = 14 * DAY_MS;
const FITS_FROM_MS = 60 * DAY_MS;
const BANK_STALE_MS = 2 * DAY_MS;

/** A change to the allowance at one instant. `quote` is set for a quote's signing and its repayments. */
type Flow = {
  at: number;
  kind: "repayment" | "signing";
  deltaCents: number;
  label: string | null;
  quote: OutlookQuote | null;
  passed: boolean;
};

/** Flows in time order with the balance after each. */
type Run = { nowCents: number; flows: Flow[]; balances: number[] };

/**
 * Game due dates of the unpaid instalments: 7 days after the last repayment (or the start), then weekly. Nothing was
 * paid by `paidAfter` (the end of the bank data), so one due before it is counted just after it, and the rest follow
 * on from there as the game's clock does.
 */
function unpaidDueDates(start: Date, paidAt: Date[], count: number, paidAfter = Number.NEGATIVE_INFINITY): number[] {
  const dates: number[] = [];
  let previous = (paidAt.at(-1) ?? start).getTime();
  for (let k = paidAt.length; k < count; k++) {
    previous = Math.max(previous + WEEK_MS, paidAfter + 1);
    dates.push(previous);
  }
  return dates;
}

export function isBehind(m: OutlookMortgage, bankTo: Date | null): boolean {
  if (!bankTo) return false;
  const [firstUnpaid] = unpaidDueDates(m.originatedAt, m.paidAt, m.instalments.length);
  return firstUnpaid !== undefined && firstUnpaid < bankTo.getTime() - BEHIND_GRACE_MS;
}

/** The rule's effect in whole dollars (`|| 0`: never −0, which would show up in comparisons). */
function ruleDelta(rule: AllowanceRule, e: AllowanceEvent): number {
  return wholeDollars(effect(rule, e)) || 0;
}

function repaymentDelta(rule: AllowanceRule, i: OutlookInstalment): number {
  return ruleDelta(rule, { kind: "repayment", at: new Date(0), grossCents: i.totalCents, principalCents: i.principalCents, label: "" });
}

function signingDelta(rule: AllowanceRule, loanCents: number): number {
  return ruleDelta(rule, { kind: "origination", at: new Date(0), loanCents, label: "" });
}

/** Expected repayments of the unpaid instalments, from the game's due dates. Zero-effect ones are left out. */
function expectedRepayments(
  rule: AllowanceRule,
  start: Date,
  paidAt: Date[],
  instalments: OutlookInstalment[],
  label: string | null,
  quote: OutlookQuote | null,
  paidAfter?: number,
): Flow[] {
  return unpaidDueDates(start, paidAt, instalments.length, paidAfter)
    .map((at, i) => ({ at, kind: "repayment" as const, deltaCents: repaymentDelta(rule, instalments[paidAt.length + i]), label, quote, passed: false }))
    .filter((f) => f.deltaCents !== 0);
}

function signingFlow(rule: AllowanceRule, q: OutlookQuote, at: number, passed: boolean): Flow {
  return { at, kind: "signing", deltaCents: signingDelta(rule, q.loanCents), label: q.address, quote: q, passed };
}

/** When an unsigned quote counts: its signing time, or now once that has passed. */
function effectiveSigning(expected: Date, now: Date): { at: number; passed: boolean } {
  const passed = expected.getTime() < now.getTime();
  return { at: passed ? now.getTime() : expected.getTime(), passed };
}

/** Signings before repayments at the same instant, then the lower quote number. */
function compareFlows(a: Pick<Flow, "at" | "kind" | "quote">, b: Pick<Flow, "at" | "kind" | "quote">): number {
  const rank = (f: Pick<Flow, "kind">) => (f.kind === "signing" ? 0 : 1);
  const number = (f: Pick<Flow, "quote">) => f.quote?.number ?? Number.POSITIVE_INFINITY;
  return a.at - b.at || rank(a) - rank(b) || (number(a) === number(b) ? 0 : number(a) < number(b) ? -1 : 1);
}

function drawsOnAllowance(q: OutlookQuote): boolean {
  return !q.companyFunded;
}

function isConfirmedSigning(f: Flow): boolean {
  return f.kind === "signing" && f.quote !== null && f.quote.signedAt === null;
}

/**
 * Allowance now plus every later flow from mortgages and confirmed quotes (all instalments, not just to the
 * horizon). `excludeQuoteId` leaves one quote out (a confirmed quote being re-timed).
 */
function baseline(input: OutlookInput, rule: AllowanceRule, excludeQuoteId?: string): Run & { behind: number } {
  const { now, reading, bankTo } = input;
  const anchor = Math.max(reading.at.getTime(), (bankTo ?? reading.at).getTime());
  const dated: Flow[] = [];
  const pending: Flow[] = [];
  let behind = 0;

  for (const m of input.mortgages) {
    if (m.status !== "active" || m.instalments.length === 0) continue;
    if (isBehind(m, bankTo)) {
      behind++;
      continue;
    }
    dated.push(...expectedRepayments(rule, m.originatedAt, m.paidAt, m.instalments, m.label, null, bankTo?.getTime()).filter((f) => f.at > anchor));
  }

  for (const q of input.quotes) {
    if (q.status !== "confirmed" || !drawsOnAllowance(q) || q.id === excludeQuoteId) continue;
    if (q.signedAt) {
      if (q.signedAt.getTime() > reading.at.getTime()) dated.push(signingFlow(rule, q, q.signedAt.getTime(), true));
      dated.push(...expectedRepayments(rule, q.signedAt, [], q.instalments, q.address, q).filter((f) => f.at > anchor));
    } else if (q.expectedSigningAt) {
      const signing = effectiveSigning(q.expectedSigningAt, now);
      pending.push(signingFlow(rule, q, signing.at, signing.passed));
      pending.push(...expectedRepayments(rule, new Date(signing.at), [], q.instalments, q.address, q).filter((f) => f.at > anchor));
    }
  }

  const known = input.knownEvents
    .filter((e) => e.at.getTime() > reading.at.getTime() && e.at.getTime() <= now.getTime())
    .reduce((sum, e) => sum + ruleDelta(rule, e), 0);
  const settled = dated.filter((f) => f.at <= now.getTime()).reduce((sum, f) => sum + f.deltaCents, 0);
  const nowCents = reading.balanceCents + known + settled;

  const flows = [...dated.filter((f) => f.at > now.getTime()), ...pending].sort(compareFlows);
  const balances: number[] = [];
  flows.reduce((balance, f) => {
    balances.push(balance + f.deltaCents);
    return balance + f.deltaCents;
  }, nowCents);
  return { nowCents, flows, balances, behind };
}

/** Balance after flow `i` (`i = −1`: now). */
function balanceAfter(run: Run, i: number): number {
  return i < 0 ? run.nowCents : run.balances[i];
}

function verdictFor(afterCents: number, cushionCents: number): Verdict {
  if (afterCents < 0) return "short";
  return afterCents < cushionCents ? "tight" : "fits";
}

/** Index of the last flow before a signing of `q` at `at` (−1 = none). */
function naturalPosition(run: Run, q: OutlookQuote, at: number): number {
  const signing = { at, kind: "signing" as const, quote: q };
  return run.flows.filter((f) => compareFlows(f, signing) < 0).length - 1;
}

/**
 * `q` signed at `at`, placed right after flow `position`. Every later flow's balance moves by the signing plus the
 * quote's own repayments before it (at the same instant a signing comes before a repayment).
 */
function insertQuote(run: Run, rule: AllowanceRule, q: OutlookQuote, at: number, position: number) {
  const signing = signingDelta(rule, q.loanCents);
  const repayments = expectedRepayments(rule, new Date(at), [], q.instalments, q.address, q);
  const beforeCents = balanceAfter(run, position);
  const laterConfirmed = run.flows.flatMap((f, j) => {
    if (j <= position || !isConfirmedSigning(f)) return [];
    const own = repayments.filter((r) => r.at < f.at).reduce((sum, r) => sum + r.deltaCents, 0);
    return [{ flow: f, withoutCents: run.balances[j], withCents: run.balances[j] + signing + own }];
  });
  return { beforeCents, afterCents: beforeCents + signing, laterConfirmed };
}

/**
 * The first time `q` would fit: its signing time, then right after each later flow (up to 60 days after the
 * signing), keeping its own balance and every later confirmed signing at or above zero.
 */
function fitsFrom(run: Run, rule: AllowanceRule, q: OutlookQuote, at: number): Date | null {
  const first = naturalPosition(run, q, at);
  for (let i = first; i < run.flows.length; i++) {
    const time = i === first ? at : run.flows[i].at;
    if (time > at + FITS_FROM_MS) break;
    const placed = insertQuote(run, rule, q, time, i);
    if (placed.afterCents >= 0 && placed.laterConfirmed.every((c) => c.withCents >= 0)) return new Date(time);
  }
  return null;
}

/** `q` as a what-if at `expected` (now once passed): before, after, verdict and, when short, when it would fit. */
function whatIf(run: Run, input: OutlookInput, rule: AllowanceRule, q: OutlookQuote, expected: Date) {
  const signing = effectiveSigning(expected, input.now);
  const position = naturalPosition(run, q, signing.at);
  const placed = insertQuote(run, rule, q, signing.at, position);
  const verdict = verdictFor(placed.afterCents, input.cushionCents);
  const outlook: QuoteOutlook = {
    quoteId: q.id,
    number: q.number,
    signingAt: new Date(signing.at),
    passed: signing.passed,
    beforeCents: placed.beforeCents,
    afterCents: placed.afterCents,
    verdict,
    fitsFrom: verdict === "short" ? fitsFrom(run, rule, q, signing.at) : null,
  };
  return { outlook, position, laterConfirmed: placed.laterConfirmed };
}

function toStep(f: Flow, balanceCents: number): OutlookStep {
  return { at: new Date(f.at), kind: f.kind, deltaCents: f.deltaCents, balanceCents, label: f.label, quoteNumber: f.quote?.number ?? null };
}

function horizonFor(input: OutlookInput): number {
  const signings = input.quotes
    .filter((q) => drawsOnAllowance(q) && q.signedAt === null && q.expectedSigningAt !== null)
    .map((q) => effectiveSigning(q.expectedSigningAt as Date, input.now).at);
  return Math.max(input.now.getTime() + HORIZON_MS, ...signings);
}

export function projectOutlook(input: OutlookInput, ruleSource: AllowanceOutlook["ruleSource"]): AllowanceOutlook {
  const rule = input.rule ?? NO_RULE;
  const run = baseline(input, rule);
  const horizon = horizonFor(input);

  const steps = run.flows.flatMap((f, i) => (f.at <= horizon ? [toStep(f, run.balances[i])] : []));
  const lineTo = Math.max(horizon, input.now.getTime() + FITS_FROM_MS);
  const lineSteps = run.flows.flatMap((f, i) => (f.at <= lineTo ? [toStep(f, run.balances[i])] : []));
  let lowest: AllowanceOutlook["lowest"] = { at: input.now, balanceCents: run.nowCents, quoteNumber: null };
  for (const s of steps) {
    if (s.balanceCents < lowest.balanceCents) lowest = { at: s.at, balanceCents: s.balanceCents, quoteNumber: s.kind === "signing" ? s.quoteNumber : null };
  }

  const confirmed = run.flows.flatMap((f, i): QuoteOutlook[] => {
    if (!isConfirmedSigning(f) || !f.quote) return [];
    const afterCents = run.balances[i];
    return [
      {
        quoteId: f.quote.id,
        number: f.quote.number,
        signingAt: new Date(f.at),
        passed: f.passed,
        beforeCents: balanceAfter(run, i - 1),
        afterCents,
        verdict: verdictFor(afterCents, input.cushionCents),
        fitsFrom: null,
      },
    ];
  });

  const drafts = input.quotes
    .filter((q) => q.status === "draft" && drawsOnAllowance(q) && q.expectedSigningAt !== null)
    .map((q) => whatIf(run, input, rule, q, q.expectedSigningAt as Date).outlook)
    .sort((a, b) => a.signingAt.getTime() - b.signingAt.getTime() || a.number - b.number);

  return {
    rule,
    ruleSource,
    readingAt: input.reading.at,
    bankTo: input.bankTo,
    bankStale: input.bankTo !== null && input.now.getTime() - input.bankTo.getTime() > BANK_STALE_MS,
    nowCents: run.nowCents,
    horizon: new Date(horizon),
    steps,
    lineSteps,
    endCents: steps.at(-1)?.balanceCents ?? run.nowCents,
    lowest,
    behind: run.behind,
    confirmed,
    drafts,
  };
}

/** What a signing takes from the allowance under `rule` (whole dollars, positive). */
export function allowanceTaken(rule: AllowanceRule, loanCents: number): number {
  return -signingDelta(rule, loanCents) || 0;
}

/**
 * A confirmed quote's working, read off the outlook (the same figures as the Quotes list): every step before its
 * signing. Null when it isn't an unsigned, State-funded confirmed quote in the outlook.
 */
export function confirmedWorking(o: AllowanceOutlook, quoteId: string): ConfirmPreview | null {
  const quote = o.confirmed.find((c) => c.quoteId === quoteId);
  if (!quote) return null;
  const i = o.steps.findIndex((s) => s.kind === "signing" && s.quoteNumber === quote.number);
  if (i < 0) return null;
  const earlier = o.steps.slice(0, i);
  const repayments = earlier.filter((s) => s.kind === "repayment");
  const signings = earlier.filter((s) => s.kind === "signing");
  return {
    nowCents: o.nowCents,
    repayments: { count: repayments.length, cents: repayments.reduce((sum, s) => sum + s.deltaCents, 0) },
    signings: { numbers: signings.flatMap((s) => (s.quoteNumber !== null ? [s.quoteNumber] : [])), cents: signings.reduce((sum, s) => sum - s.deltaCents, 0) },
    quote,
    knockOn: [],
  };
}

/**
 * The projected balance over time with one quote left out (its signing and its own repayments): what the quote form
 * measures a quote against while it is being edited. Holds totals only, never what a step was.
 */
export type AllowanceLine = {
  now: number;
  nowCents: number;
  /** Signing order; `balanceCents` is the balance after the step. */
  steps: { at: number; signing: boolean; balanceCents: number }[];
  /** What the confirmed signings ahead take (excluding the quote left out). */
  confirmedCents: number;
};

export function allowanceLine(o: AllowanceOutlook, now: Date, excludeQuoteNumber: number | null): AllowanceLine {
  let balance = o.nowCents;
  const steps = o.lineSteps.flatMap((s) => {
    if (excludeQuoteNumber !== null && s.quoteNumber === excludeQuoteNumber) return [];
    balance += s.deltaCents;
    return [{ at: s.at.getTime(), signing: s.kind === "signing", balanceCents: balance }];
  });
  const confirmedCents = o.confirmed.filter((c) => c.number !== excludeQuoteNumber).reduce((sum, c) => sum + c.beforeCents - c.afterCents, 0);
  return { now: now.getTime(), nowCents: o.nowCents, steps, confirmedCents };
}

/**
 * The balance just before a new signing at `at` (now, once passed): after every step before it, and after other
 * signings at the same instant (signings come before repayments, and a new quote has the highest number).
 */
export function balanceBefore(line: AllowanceLine, at: number): number {
  const t = Math.max(at, line.now);
  let balance = line.nowCents;
  for (const s of line.steps) {
    if (s.at > t || (s.at === t && !s.signing)) break;
    balance = s.balanceCents;
  }
  return balance;
}

/**
 * Confirming `quoteId` (a draft, or a confirmed quote being re-timed) at `signingAt`: the working up to its signing,
 * its verdict, and the confirmed quotes it would push short. A company-funded quote doesn't touch the allowance.
 */
export function previewConfirmation(input: OutlookInput, quoteId: string, signingAt: Date): ConfirmPreview {
  const q = input.quotes.find((x) => x.id === quoteId);
  if (!q) throw new Error(`Quote ${quoteId} is not in the outlook's input.`);
  const rule = input.rule ?? NO_RULE;
  const run = baseline(input, rule, q.id);
  const { outlook, position, laterConfirmed } = whatIf(run, input, rule, q, signingAt);

  const earlier = run.flows.slice(0, position + 1);
  const repayments = earlier.filter((f) => f.kind === "repayment");
  const signings = earlier.filter((f) => f.kind === "signing");
  const working = {
    nowCents: run.nowCents,
    repayments: { count: repayments.length, cents: repayments.reduce((sum, f) => sum + f.deltaCents, 0) },
    signings: { numbers: signings.flatMap((f) => (f.quote ? [f.quote.number] : [])), cents: signings.reduce((sum, f) => sum - f.deltaCents, 0) },
  };

  if (!drawsOnAllowance(q)) {
    return { ...working, quote: { ...outlook, afterCents: outlook.beforeCents, verdict: "fits", fitsFrom: null }, knockOn: [] };
  }
  const knockOn = laterConfirmed
    .filter((c) => c.withoutCents >= 0 && c.withCents < 0)
    .flatMap((c) => (c.flow.quote ? [{ quoteId: c.flow.quote.id, number: c.flow.quote.number, officerStaffId: c.flow.quote.officerStaffId, shortByCents: -c.withCents }] : []));
  return { ...working, quote: outlook, knockOn };
}
