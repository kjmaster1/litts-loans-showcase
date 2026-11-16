import type { Category } from "@/domain/ledger/categories";

/**
 * Links imported bank rows to loans (docs/design/LOANS.md). Pure.
 *
 * A loan is born from its disbursement ("Loan Transfer" out to the borrower).
 * Payment rows from the same borrower are attached using, in order of trust:
 *   1. agreement   — the amount written in the comment ("Loan Agreement Amount: $P…"):
 *                    the principal, or in early game versions the total repayable
 *   2. reference   — the 24-hex agreement ID learned from other rows of the same loan
 *   3. instalments — the "k/N" count, when only one of the borrower's loans has N payments
 *   4. timing      — the $1 broker fee charged seconds before the disbursement
 *   5. paired      — no identifier, but paid in the same second as an identified row
 *   6. open_loan   — no identifier: the borrower's oldest loan still open at that time
 */

export type LinkableRow = {
  id: string;
  occurredAt: Date;
  category: Category;
  comment: string;
  amountCents: number;
  initiatorStateId: number | null;
};

export type DerivedLoan = {
  /** The disbursement bank row id — the loan's identity. */
  disbursementTxId: string;
  borrowerStateId: number;
  principalCents: number;
  openedAt: Date;
};

export type LinkRole = "disbursement" | "fee" | "principal" | "interest" | "early_principal" | "early_interest" | "late_principal" | "late_fee" | "recovery" | "refund";
export type LinkMethod = "disbursement" | "agreement" | "reference" | "instalments" | "timing" | "paired" | "open_loan" | "borrower_named" | "borrower_wallet";

export type PaymentLink = { txId: string; disbursementTxId: string; role: LinkRole; method: LinkMethod };

const ROLE: Partial<Record<Category, LinkRole>> = {
  "loan.origination_fee": "fee",
  "loan.principal": "principal",
  "loan.interest": "interest",
  "loan.early_principal": "early_principal",
  "loan.early_interest": "early_interest",
  "loan.late_principal": "late_principal",
  "loan.late_fee": "late_fee",
};

const PRINCIPAL_ROLES: ReadonlySet<LinkRole> = new Set(["principal", "early_principal", "late_principal"]);
/** A loan counts as open until this share of principal has come back (the State keeps up to ~1%). */
const OPEN_THRESHOLD = 0.97;
const FEE_WINDOW_MS = 30_000;

/**
 * "Subscription payment Loan Agreement Amount: $6000012/12" — principal and
 * instalment number are concatenated. Returns every principal (in cents) that
 * yields a valid "k/N" split; the caller picks the one matching a real loan.
 */
export function subscriptionPrincipalCandidates(comment: string): { principals: number[]; instalments: number } | null {
  const m = /Loan Agreement Amount:\s*\$(\d+)\/(\d+)\s*$/.exec(comment.trim());
  if (!m) return null;
  const digits = m[1];
  const n = Number(m[2]);
  const principals: number[] = [];
  for (let i = 1; i < digits.length; i++) {
    const p = digits.slice(0, i);
    const k = digits.slice(i);
    if (k.length > 1 && k.startsWith("0")) continue;
    if (Number(k) > n || Number(p) < 100) continue;
    principals.push(Number(p) * 100);
  }
  return { principals, instalments: n };
}

/** "Broker percentage payment: Loan Agreement Amount: $80000 ID: 6a…" → principal + reference. */
export function brokerPaymentRef(comment: string): { principalCents: number | null; reference: string | null } {
  const p = /Loan Agreement Amount:\s*\$(\d+)\s+ID:/.exec(comment);
  const ref = /\bID:\s*([0-9a-f]{24})\b/.exec(comment);
  return { principalCents: p ? Number(p[1]) * 100 : null, reference: ref ? ref[1] : null };
}

export function deriveLoans(rows: LinkableRow[]): DerivedLoan[] {
  return rows
    .filter((r) => r.category === "loan.disbursement" && r.initiatorStateId !== null)
    .map((r) => ({ disbursementTxId: r.id, borrowerStateId: r.initiatorStateId!, principalCents: r.amountCents, openedAt: r.occurredAt }))
    .sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime());
}

/**
 * Does an amount written in a comment identify this loan? Either it's the
 * principal, or — in the early game versions (Jan–Apr 2026) — the total
 * repayable, principal × (1 + broker rate), with a plausible rate (≤ 35%, in
 * half-percent steps).
 */
export function agreementFits(amountCents: number, principalCents: number): "principal" | "total" | null {
  if (amountCents === principalCents) return "principal";
  if (amountCents <= principalCents || principalCents <= 0) return null;
  const rate = amountCents / principalCents - 1;
  if (rate > 0.35) return null;
  const halfPercents = Math.round(rate * 200);
  return Math.abs(principalCents * (1 + halfPercents / 200) - amountCents) <= 100 ? "total" : null;
}

/** "… Missed payment 1/8 (1 missed)3/8" or "…$240001/8" → N (the total number of instalments). */
export function instalmentsInComment(comment: string): number | null {
  const m = /(\d+)\/(\d+)\s*(?:\(|$)|(\d+)\/(\d+)\s*complete/.exec(comment.trim()) ?? /\/(\d+)\s*$/.exec(comment.trim());
  if (!m) return null;
  const n = Number(m[2] ?? m[4] ?? m[1]);
  return n > 0 && n <= 104 ? n : null;
}

/** Rows within this many ms of each other are one payment (principal + interest). */
const PAIR_MS = 2_000;

export function linkPayments(rows: LinkableRow[], loans: DerivedLoan[] = deriveLoans(rows)): {
  links: PaymentLink[];
  references: Map<string, string>;
  unlinked: LinkableRow[];
} {
  const byBorrower = new Map<number, DerivedLoan[]>();
  for (const loan of loans) {
    const list = byBorrower.get(loan.borrowerStateId) ?? [];
    list.push(loan);
    byBorrower.set(loan.borrowerStateId, list);
  }
  const loanById = new Map(loans.map((l) => [l.disbursementTxId, l]));
  const sorted = [...rows].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

  /** The borrower's loan opened at or before `at` that an amount from a comment identifies (exact principal beats total repayable). */
  const byAgreement = (stateId: number, amounts: number[], at: Date): DerivedLoan | undefined => {
    const mine = (byBorrower.get(stateId) ?? []).filter((l) => l.openedAt <= at);
    for (const kind of ["principal", "total"] as const) {
      const hit = mine.filter((l) => amounts.some((a) => agreementFits(a, l.principalCents) === kind)).at(-1);
      if (hit) return hit;
    }
    return undefined;
  };

  // Pass 1: learn what identifies each loan — its agreement IDs and its number of instalments.
  const references = new Map<string, string>();
  /** Loans some agreement ID already points at (kept beside `references` so the check below is a lookup, not a scan). */
  const referenced = new Set<string>();
  const remember = (reference: string, loanId: string) => {
    references.set(reference, loanId);
    referenced.add(loanId);
  };
  const instalmentsOf = new Map<string, number>();
  const learn = (loanId: string, comment: string) => {
    const n = instalmentsInComment(comment);
    if (n && !instalmentsOf.has(loanId)) instalmentsOf.set(loanId, n);
  };
  for (const r of sorted) {
    if (r.initiatorStateId === null) continue;
    if (r.category === "loan.interest") {
      const { principalCents, reference } = brokerPaymentRef(r.comment);
      const loan = principalCents ? byAgreement(r.initiatorStateId, [principalCents], r.occurredAt) : undefined;
      if (loan && reference && !references.has(reference)) remember(reference, loan.disbursementTxId);
    } else if (r.category === "loan.principal") {
      const sub = subscriptionPrincipalCandidates(r.comment);
      const loan = sub ? byAgreement(r.initiatorStateId, sub.principals, r.occurredAt) : undefined;
      if (loan && sub) instalmentsOf.set(loan.disbursementTxId, sub.instalments);
    }
  }
  // IDs and instalment counts seen together teach each other (a few rounds settle it).
  for (let round = 0; round < 3; round++) {
    for (const r of sorted) {
      if (r.initiatorStateId === null || (r.category !== "loan.interest" && r.category !== "loan.principal")) continue;
      const { reference } = brokerPaymentRef(r.comment);
      const n = instalmentsInComment(r.comment);
      if (reference && references.has(reference)) {
        learn(references.get(reference)!, r.comment);
      } else if (reference && n) {
        // An unknown ID: the borrower's only loan this instalment count could belong to.
        const fits = (byBorrower.get(r.initiatorStateId) ?? []).filter(
          (l) => l.openedAt <= r.occurredAt && (instalmentsOf.get(l.disbursementTxId) ?? n) === n && !referenced.has(l.disbursementTxId),
        );
        if (fits.length === 1) {
          remember(reference, fits[0].disbursementTxId);
          instalmentsOf.set(fits[0].disbursementTxId, n);
        }
      }
    }
  }

  // Pass 2: rows that identify their loan themselves.
  const assigned = new Map<string, { loanId: string; method: LinkMethod }>();
  for (const r of sorted) {
    const role = ROLE[r.category];
    const stateId = r.initiatorStateId;
    if (!role || stateId === null || !byBorrower.has(stateId)) continue;
    let hit: { loanId: string; method: LinkMethod } | undefined;
    if (role === "fee") {
      const next = byBorrower.get(stateId)!.find((l) => Math.abs(l.openedAt.getTime() - r.occurredAt.getTime()) <= FEE_WINDOW_MS);
      if (next) hit = { loanId: next.disbursementTxId, method: "timing" };
    } else if (role === "principal" || role === "interest") {
      const sub = role === "principal" ? subscriptionPrincipalCandidates(r.comment) : null;
      const { principalCents, reference } = brokerPaymentRef(r.comment);
      const amounts = sub?.principals ?? (principalCents ? [principalCents] : []);
      const byAmount = amounts.length ? byAgreement(stateId, amounts, r.occurredAt) : undefined;
      if (byAmount) hit = { loanId: byAmount.disbursementTxId, method: "agreement" };
      else if (reference && references.has(reference)) hit = { loanId: references.get(reference)!, method: "reference" };
      else {
        const n = instalmentsInComment(r.comment);
        const fits = n ? byBorrower.get(stateId)!.filter((l) => l.openedAt <= r.occurredAt && instalmentsOf.get(l.disbursementTxId) === n) : [];
        if (fits.length === 1) hit = { loanId: fits[0].disbursementTxId, method: "instalments" };
      }
    }
    if (hit && loanById.has(hit.loanId)) assigned.set(r.id, hit);
  }

  // Pass 3: rows with no identifier (early/late repayments, …). A row paid in the same
  // second as an identified row of the same borrower is part of that payment. Otherwise
  // the rows paid together (principal + interest, same second) go to one loan: the
  // borrower's oldest loan still open that has enough principal left to take them —
  // or, if none has, the oldest open one (Indie Hartwell, 27 Feb 2026: a $24,000 early
  // repayment had gone to a loan with $1,130 left instead of her other loan).
  const links: PaymentLink[] = loans.map((l) => ({ txId: l.disbursementTxId, disbursementTxId: l.disbursementTxId, role: "disbursement", method: "disbursement" }));
  const unlinked: LinkableRow[] = [];
  const returned = new Map<string, number>();
  // Each borrower's payment rows, oldest first: the searches below look only at one borrower's rows
  // (review 2026-10-13 — they used to scan every loan row for every row).
  const paymentsOf = new Map<number, LinkableRow[]>();
  for (const r of sorted) {
    if (!ROLE[r.category] || r.initiatorStateId === null) continue;
    const list = paymentsOf.get(r.initiatorStateId) ?? [];
    list.push(r);
    paymentsOf.set(r.initiatorStateId, list);
  }
  const near = (list: LinkableRow[], r: LinkableRow) => list.filter((o) => Math.abs(o.occurredAt.getTime() - r.occurredAt.getTime()) <= PAIR_MS);
  /** Unidentified rows already placed, so the rest of their payment follows them. */
  const placedTogether = new Map<string, { loanId: string; method: LinkMethod }>();

  for (const r of sorted) {
    const role = ROLE[r.category];
    if (!role) continue;
    const stateId = r.initiatorStateId;
    if (stateId === null || !byBorrower.has(stateId)) {
      unlinked.push(r);
      continue;
    }
    let hit = assigned.get(r.id);
    const sameMoment = near(paymentsOf.get(stateId) ?? [], r);
    if (!hit) {
      const partner = sameMoment.find((o) => o.id !== r.id && assigned.has(o.id));
      if (partner) hit = { loanId: assigned.get(partner.id)!.loanId, method: "paired" };
    }
    // The rest of this payment: unidentified rows of the same borrower in the same second.
    const together = sameMoment.filter((o) => !assigned.has(o.id));
    if (!hit) hit = together.map((o) => placedTogether.get(o.id)).find(Boolean);
    if (!hit) {
      const open = byBorrower
        .get(stateId)!
        .filter((l) => l.openedAt <= r.occurredAt && (returned.get(l.disbursementTxId) ?? 0) < l.principalCents * OPEN_THRESHOLD);
      const principalPaid = together.filter((o) => PRINCIPAL_ROLES.has(ROLE[o.category]!)).reduce((s, o) => s + o.amountCents, 0);
      // Room on a loan: principal not yet returned, with slack for rounding and the State's share.
      const fits = (l: DerivedLoan) => principalPaid <= l.principalCents - (returned.get(l.disbursementTxId) ?? 0) + Math.max(10_000, l.principalCents * 0.03);
      const fallback = open.find(fits) ?? open[0] ?? byBorrower.get(stateId)!.filter((l) => l.openedAt <= r.occurredAt).at(-1);
      if (fallback) hit = { loanId: fallback.disbursementTxId, method: "open_loan" };
    }
    if (hit && !assigned.has(r.id)) placedTogether.set(r.id, hit);
    if (!hit) {
      unlinked.push(r);
      continue;
    }
    if (PRINCIPAL_ROLES.has(role)) returned.set(hit.loanId, (returned.get(hit.loanId) ?? 0) + r.amountCents);
    links.push({ txId: r.id, disbursementTxId: hit.loanId, role, method: hit.method });
  }

  return { links, references, unlinked };
}
