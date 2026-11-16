/**
 * Recognising the same mortgage across sources (docs/design/MORTGAGES.md). Pure.
 *
 * The server sometimes renumbers houses, so a tablet agreement, its down
 * payment and its repayments can carry different addresses. The money is the
 * reliable link:
 *  - State-funded: the down payment row nets down payment + banker fee + agency
 *    commission; the transfer to the State is down payment + agency commission.
 *  - Company-funded (Litt's lends its own money): the row nets down payment +
 *    banker fee; the transfer to the State is down payment + loan.
 */

export const normaliseAddress = (a: string) => a.trim().replace(/\s+/g, " ").toLowerCase();

export function hasAddress(m: { address: string; addressAliases: string[] }, address: string): boolean {
  const n = normaliseAddress(address);
  return normaliseAddress(m.address) === n || m.addressAliases.some((a) => normaliseAddress(a) === n);
}

export type AgreementAmounts = {
  downPaymentCents: number | null;
  brokerFeeCents: number | null;
  agencyCommissionCents: number | null;
  loanCents: number | null;
};
export type Funding = "state" | "company";

/** The tablet shows no federal interest or fed rate when Litt's funds the loan itself. */
export function fundingOf(t: { fedRateBp: number | null; federalInterestCents: number | null }): Funding {
  return t.fedRateBp === null && t.federalInterestCents === null ? "company" : "state";
}
export type OriginationAmounts = { netInCents: number; outCents: number | null };

/** Which funding pattern the origination money follows exactly, if either. */
export function originationPattern(t: AgreementAmounts, o: OriginationAmounts): Funding | null {
  const { downPaymentCents: down, brokerFeeCents: fee, agencyCommissionCents: agency, loanCents: loan } = t;
  if (down === null || fee === null) return null;
  if (agency !== null && o.netInCents === down + fee + agency && (o.outCents === null || o.outCents === down + agency)) return "state";
  if (loan !== null && o.netInCents === down + fee && (o.outCents === null || o.outCents === down + loan)) return "company";
  return null;
}

/** Exact match on the money received (and the transfer to the State, once it's known). */
export function originationFits(t: AgreementAmounts, o: OriginationAmounts): boolean {
  return originationPattern(t, o) !== null;
}

/**
 * Why an agreement can't start a new mortgage record (empty = it can). Updating a
 * known mortgage may use a partial paste (a missing field never erases one), but a
 * new record needs enough to be a real mortgage — a malformed paste once became a
 * duplicate with no terms (2026-10-12).
 */
export function problemsForNewMortgage(t: {
  addressRecognised: boolean;
  buyer: { stateId: number | null } | null;
  downPaymentCents: number | null;
  loanCents: number | null;
  instalments: number | null;
}): string[] {
  const problems: string[] = [];
  if (!t.addressRecognised) problems.push("No property address. Copy from the address line (e.g. “107 Amarillo Vista”) down to “After Tax”.");
  if (!t.buyer?.stateId) problems.push("No buyer State ID.");
  if (t.downPaymentCents === null || t.loanCents === null) problems.push("No down payment or loan amount. Open “Loan details” on the tablet before copying.");
  if (t.instalments === null) problems.push("No number of weekly payments.");
  return problems;
}

export type ExistingMortgage = {
  id: string;
  buyerStateId: number | null;
  priceCents: number | null;
  loanCents: number | null;
  lastTabletAt: Date | null;
};

/**
 * Mortgages a would-be new agreement may really be: the same buyer's, at the same
 * price or loan, or not yet pasted at all. Someone has to say which (or that it's
 * genuinely another property) — a buyer can own two flats at the same price.
 */
export function duplicateCandidates<M extends ExistingMortgage>(
  t: { buyer: { stateId: number | null } | null; priceCents: number | null; loanCents: number | null },
  mortgages: M[],
): M[] {
  const buyer = t.buyer?.stateId;
  if (!buyer) return [];
  return mortgages.filter(
    (m) =>
      m.buyerStateId === buyer &&
      (m.lastTabletAt === null || (t.priceCents !== null && m.priceCents === t.priceCents) || (t.loanCents !== null && m.loanCents === t.loanCents)),
  );
}

export function withAlias(aliases: string[], current: string, previous: string): string[] {
  if (normaliseAddress(current) === normaliseAddress(previous)) return aliases;
  return aliases.some((a) => normaliseAddress(a) === normaliseAddress(previous)) ? aliases : [...aliases, previous];
}

/** The mortgage's address once the game shows `address`; the old one becomes a former address. Null if unchanged. */
export function movedTo(m: { address: string; addressAliases: string[] }, address: string): { address: string; addressAliases: string[] } | null {
  if (normaliseAddress(m.address) === normaliseAddress(address)) return null;
  const others = m.addressAliases.filter((a) => normaliseAddress(a) !== normaliseAddress(address));
  return { address, addressAliases: withAlias(others, address, m.address) };
}

export type RepaymentCandidate = {
  address: string;
  addressAliases: string[];
  buyerStateId: number | null;
  originatedAt: Date | null;
  status: "active" | "completed" | "defaulted";
  /** Gross of the repayments already linked to it. */
  paidGrossCents: number[];
};
export type RepaymentRow = { address: string | null; payerStateId: number | null; occurredAt: Date; grossCents: number };

/**
 * The mortgage a "<addr>: Loan Repayment" row belongs to (2026-10-28). The game takes each repayment from the
 * buyer, so the payer's State ID is the link; the address only tells a buyer's mortgages apart. The server keeps
 * renumbering houses and hands old numbers to other houses, so an address alone once linked Cheri Bush's repayment
 * to Noel Dunmore's mortgage (115 North Rockford Dr had been his). When the address fits none of the payer's
 * mortgages, their only open one takes it, or the one whose repayments were the same amount; otherwise nothing does
 * (someone decides). A payer with no mortgage on record falls back to the address (a house sold under mortgage).
 */
export function repaymentMortgage<M extends RepaymentCandidate>(r: RepaymentRow, mortgages: M[]): { mortgage: M; by: "address" | "buyer" } | null {
  const started = (m: M) => m.originatedAt !== null && m.originatedAt <= r.occurredAt;
  // The latest mortgage on that address started before the payment, else one not in the bank yet (tablet only).
  const latestAt = (ms: M[]) => ms.filter(started).sort((a, b) => b.originatedAt!.getTime() - a.originatedAt!.getTime())[0] ?? ms.find((m) => !m.originatedAt);
  const atAddress = (ms: M[]) => (r.address === null ? undefined : latestAt(ms.filter((m) => hasAddress(m, r.address!))));

  const own = r.payerStateId === null ? [] : mortgages.filter((m) => m.buyerStateId === r.payerStateId);
  if (own.length === 0) {
    const m = atAddress(mortgages);
    return m ? { mortgage: m, by: "address" } : null;
  }
  const same = atAddress(own);
  if (same) return { mortgage: same, by: "address" };
  const open = own.filter((m) => m.status === "active" && (m.originatedAt === null || started(m)));
  if (open.length === 1) return { mortgage: open[0], by: "buyer" };
  const sameAmount = open.filter((m) => m.paidGrossCents.includes(r.grossCents));
  return sameAmount.length === 1 ? { mortgage: sameAmount[0], by: "buyer" } : null;
}
