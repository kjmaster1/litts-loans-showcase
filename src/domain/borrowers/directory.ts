/**
 * The borrower directory (owner, 2026-10-11): one row per State ID across loans and
 * mortgages, with where they stand. Pure — fed by the loan and mortgage lists.
 */

export type DirectoryLoan = {
  borrowerStateId: number;
  borrowerName: string | null;
  status: "active" | "overdue" | "defaulted" | "completed" | "written_off";
  principalCents: number;
  outstandingCents: number | null;
  openedAt: Date | null;
  lastPaymentAt: Date | null;
};
export type DirectoryMortgage = {
  buyerStateId: number | null;
  buyerName: string | null;
  status: string;
  late: boolean;
  originatedAt: Date | null;
};

/** Worst first: the order the directory sorts "standing" by. */
export const STANDINGS = ["do_not_lend", "defaulted", "overdue", "late_mortgage", "active", "paid_up"] as const;
export type Standing = (typeof STANDINGS)[number];

export type DirectoryRow = {
  stateId: number;
  name: string | null;
  standing: Standing;
  openLoans: number;
  loans: number;
  openMortgages: number;
  mortgages: number;
  owedCents: number;
  lentCents: number;
  repaid: number;
  wentBad: number;
  /** Latest loan, mortgage or payment. */
  lastActivityAt: Date | null;
};

const OPEN = new Set(["active", "overdue", "defaulted"]);
const later = (a: Date | null, b: Date | null) => (!a ? b : !b ? a : a > b ? a : b);

export function borrowerDirectory(loans: DirectoryLoan[], mortgages: DirectoryMortgage[], doNotLend: Set<number>): DirectoryRow[] {
  const rows = new Map<number, DirectoryRow>();
  const row = (stateId: number, name: string | null) => {
    let r = rows.get(stateId);
    if (!r) {
      r = { stateId, name, standing: "paid_up", openLoans: 0, loans: 0, openMortgages: 0, mortgages: 0, owedCents: 0, lentCents: 0, repaid: 0, wentBad: 0, lastActivityAt: null };
      rows.set(stateId, r);
    }
    if (!r.name && name) r.name = name;
    return r;
  };
  const flags = new Map<number, Set<Standing>>();
  const flag = (id: number, s: Standing) => flags.set(id, (flags.get(id) ?? new Set()).add(s));

  for (const l of loans) {
    const r = row(l.borrowerStateId, l.borrowerName);
    r.loans++;
    r.lentCents += l.principalCents;
    r.lastActivityAt = later(r.lastActivityAt, later(l.openedAt, l.lastPaymentAt));
    if (OPEN.has(l.status)) {
      r.openLoans++;
      r.owedCents += Math.max(0, l.outstandingCents ?? 0);
    }
    if (l.status === "completed") r.repaid++;
    if (l.status === "defaulted" || l.status === "written_off") r.wentBad++;
    if (l.status === "defaulted") flag(r.stateId, "defaulted");
    if (l.status === "overdue") flag(r.stateId, "overdue");
    if (l.status === "active") flag(r.stateId, "active");
  }
  for (const m of mortgages) {
    if (m.buyerStateId === null) continue;
    const r = row(m.buyerStateId, m.buyerName);
    r.mortgages++;
    r.lastActivityAt = later(r.lastActivityAt, m.originatedAt);
    if (m.status === "active") {
      r.openMortgages++;
      flag(r.stateId, m.late ? "late_mortgage" : "active");
    }
  }
  for (const r of rows.values()) {
    if (doNotLend.has(r.stateId)) flag(r.stateId, "do_not_lend");
    const set = flags.get(r.stateId);
    r.standing = STANDINGS.find((s) => set?.has(s)) ?? "paid_up";
  }
  return [...rows.values()];
}

export type DirectorySort = "name" | "owed" | "standing" | "recent";

export function sortDirectory(rows: DirectoryRow[], sort: DirectorySort): DirectoryRow[] {
  const byName = (a: DirectoryRow, b: DirectoryRow) => (a.name ?? "~").localeCompare(b.name ?? "~") || a.stateId - b.stateId;
  const cmp: Record<DirectorySort, (a: DirectoryRow, b: DirectoryRow) => number> = {
    name: byName,
    owed: (a, b) => b.owedCents - a.owedCents || byName(a, b),
    standing: (a, b) => STANDINGS.indexOf(a.standing) - STANDINGS.indexOf(b.standing) || b.owedCents - a.owedCents || byName(a, b),
    recent: (a, b) => (b.lastActivityAt?.getTime() ?? 0) - (a.lastActivityAt?.getTime() ?? 0) || byName(a, b),
  };
  return [...rows].sort(cmp[sort]);
}

/** Name or State ID, as typed. */
export function filterDirectory(rows: DirectoryRow[], q: string): DirectoryRow[] {
  const t = q.trim().toLowerCase();
  if (!t) return rows;
  return /^\d+$/.test(t) ? rows.filter((r) => String(r.stateId).startsWith(t)) : rows.filter((r) => r.name?.toLowerCase().includes(t));
}
