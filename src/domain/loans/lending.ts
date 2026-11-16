import { formatDollars } from "@/lib/format";

/**
 * "Can we lend?" (research/11): red flags from a borrower's history and the
 * company's own track record. Information only — never an approval step
 * (ADR 0001). Pure.
 */

export type Band = { label: string; loans: number; bad: number };
export type TrackRecord = { overall: Band; bySize: Band[]; byRate: Band[]; whileOpen: Band };

export type FinishedLoan = {
  principalCents: number;
  brokerRateBp: number | null;
  /** Defaulted or written off. */
  bad: boolean;
  /** Made while the same borrower had another loan running. */
  overlapped: boolean;
};

const SIZE: { label: string; below: number }[] = [
  { label: "under $25,000", below: 2_500_000 },
  { label: "$25,000–$74,999", below: 7_500_000 },
  { label: "$75,000 or more", below: Infinity },
];
const RATE: { label: string; below: number }[] = [
  { label: "under 15%", below: 1500 },
  { label: "15–19.9%", below: 2000 },
  { label: "20% or more", below: Infinity },
];

export const sizeBand = (cents: number) => SIZE.find((b) => cents < b.below)!.label;
export const rateBand = (bp: number) => RATE.find((b) => bp < b.below)!.label;

const tally = (label: string, loans: FinishedLoan[]): Band => ({ label, loans: loans.length, bad: loans.filter((l) => l.bad).length });

export function trackRecord(finished: FinishedLoan[]): TrackRecord {
  return {
    overall: tally("all loans", finished),
    bySize: SIZE.map((b) => tally(b.label, finished.filter((l) => sizeBand(l.principalCents) === b.label))),
    byRate: RATE.map((b) => tally(b.label, finished.filter((l) => l.brokerRateBp !== null && rateBand(l.brokerRateBp) === b.label))),
    whileOpen: tally("made while another loan was running", finished.filter((l) => l.overlapped)),
  };
}

export const badShare = (b: Band) => (b.loans ? b.bad / b.loans : 0);
const pct = (b: Band) => `${Math.round(badShare(b) * 100)}%`;

export type LendingFlag = { level: "danger" | "warning" | "info" | "good"; text: string };

export type BorrowerHistory = {
  doNotLend: { reason: string; by: string; at: Date } | null;
  loans: { status: "active" | "overdue" | "defaulted" | "written_off" | "completed"; everDefaulted: boolean; outstandingCents: number | null }[];
  mortgagesBehind: number;
  isStaff: boolean;
};

/** Below this many finished loans a band says nothing useful. */
const MIN_SAMPLE = 5;
/** A band at or above this share of bad loans is worth a warning. */
const WARN_SHARE = 0.2;

export function lendingFlags(h: BorrowerHistory, request: { amountCents?: number | null; rateBp?: number | null }, record: TrackRecord): LendingFlag[] {
  const flags: LendingFlag[] = [];
  if (h.doNotLend) flags.push({ level: "danger", text: `Marked do not lend by ${h.doNotLend.by}: ${h.doNotLend.reason}` });

  const count = (s: string) => h.loans.filter((l) => l.status === s).length;
  if (count("defaulted")) flags.push({ level: "danger", text: `${count("defaulted")} loan${count("defaulted") === 1 ? " is" : "s are"} in default now` });
  if (count("written_off")) flags.push({ level: "danger", text: `${count("written_off")} loan${count("written_off") === 1 ? " was" : "s were"} written off` });
  const recovered = h.loans.filter((l) => l.everDefaulted && l.status === "completed").length;
  if (recovered) flags.push({ level: "warning", text: `Defaulted before but paid in the end (${recovered} loan${recovered === 1 ? "" : "s"})` });
  if (count("overdue")) flags.push({ level: "danger", text: `Behind on a payment now (${count("overdue")} overdue)` });
  if (h.mortgagesBehind) flags.push({ level: "warning", text: `Behind on ${h.mortgagesBehind} mortgage${h.mortgagesBehind === 1 ? "" : "s"}` });

  const running = h.loans.filter((l) => l.status === "active" || l.status === "overdue");
  if (running.length) {
    const owed = running.reduce((s, l) => s + Math.max(0, l.outstandingCents ?? 0), 0);
    const w = record.whileOpen;
    flags.push({
      level: "warning",
      text:
        `Already has ${running.length} loan${running.length === 1 ? "" : "s"} running (${formatDollars(owed)} still owed)` +
        (w.loans >= MIN_SAMPLE ? `; ${w.bad} of ${w.loans} loans made while another was running went bad (${pct(w)})` : ""),
    });
  }

  if (request.amountCents) {
    const b = record.bySize.find((x) => x.label === sizeBand(request.amountCents!))!;
    if (b.loans >= MIN_SAMPLE) {
      flags.push({ level: badShare(b) >= WARN_SHARE ? "warning" : "info", text: `Loans ${b.label}: ${b.bad} of ${b.loans} went bad (${pct(b)}; all loans ${pct(record.overall)})` });
    }
  }
  if (request.rateBp) {
    const b = record.byRate.find((x) => x.label === rateBand(request.rateBp!))!;
    if (b.loans >= MIN_SAMPLE) {
      flags.push({ level: badShare(b) >= WARN_SHARE ? "warning" : "info", text: `Rates ${b.label}: ${b.bad} of ${b.loans} went bad (${pct(b)})` });
    }
  }

  if (h.isStaff) flags.push({ level: "info", text: "Works for Litt's Loans" });
  const clean = h.loans.filter((l) => l.status === "completed" && !l.everDefaulted).length;
  if (h.loans.length === 0) flags.push({ level: "info", text: "First-time borrower: no history with Litt's" });
  else if (clean && !h.loans.some((l) => l.everDefaulted)) flags.push({ level: "good", text: `Repaid ${clean} loan${clean === 1 ? "" : "s"} in full, never defaulted` });
  return flags;
}
