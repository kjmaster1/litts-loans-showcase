import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classify } from "@/domain/bank/classify";
import { parseBankExport } from "@/domain/bank/parse-export";
import { agreementFits, brokerPaymentRef, deriveLoans, linkPayments, subscriptionPrincipalCandidates, type LinkableRow } from "./link";

const parsed = parseBankExport(readFileSync("tests/fixtures/bank-export.xlsx"));
const rows: LinkableRow[] = parsed.rows.map((r, i) => ({
  id: String(i),
  occurredAt: r.occurredAt,
  category: classify(r).category,
  comment: r.comment,
  amountCents: r.amountCents,
  initiatorStateId: r.initiatorStateId,
}));
const loans = deriveLoans(rows);
const { links, references, unlinked } = linkPayments(rows, loans);
const loanById = new Map(loans.map((l) => [l.disbursementTxId, l]));
const rowById = new Map(rows.map((r) => [r.id, r]));

describe("comment parsing", () => {
  it("tries every principal/instalment split of the concatenated digits", () => {
    expect(subscriptionPrincipalCandidates("Subscription payment Loan Agreement Amount: $400001/6")).toEqual({ principals: [4_000_000], instalments: 6 });
    // "$6000012/12" is genuinely ambiguous: 60000 + 12/12 or 600001 + 2/12.
    expect(subscriptionPrincipalCandidates("Subscription payment Loan Agreement Amount: $6000012/12")?.principals).toEqual([6_000_000, 60_000_100]);
    expect(subscriptionPrincipalCandidates("Subscription payment OVERDUE: Missed payment 2/6 (1 missed)6/6")).toBeNull();
  });

  it("reads principal and reference from broker payments", () => {
    expect(brokerPaymentRef("Broker percentage payment: Loan Agreement Amount: $80000 ID: b347b62b85ce72bc26a0f3bc")).toEqual({
      principalCents: 8_000_000,
      reference: "b347b62b85ce72bc26a0f3bc",
    });
    expect(brokerPaymentRef("Broker percentage payment: OVERDUE: Missed payment 2/8 (1 missed) ID: 2f01b2b03e6cb99063ada777")).toEqual({
      principalCents: null,
      reference: "2f01b2b03e6cb99063ada777",
    });
  });
});

describe("linking the anonymised export", () => {
  it("creates one loan per disbursement", () => {
    expect(loans).toHaveLength(85);
    expect(references.size).toBeGreaterThan(40);
  });

  it("only links a payment to the same borrower's loan, opened before the payment", () => {
    for (const link of links) {
      if (link.role === "disbursement") continue;
      const row = rowById.get(link.txId)!;
      const loan = loanById.get(link.disbursementTxId)!;
      expect(row.initiatorStateId).toBe(loan.borrowerStateId);
      if (link.role !== "fee") expect(row.occurredAt.getTime()).toBeGreaterThanOrEqual(loan.openedAt.getTime());
    }
  });

  it("links every broker fee to the disbursement it was charged with", () => {
    expect(links.filter((l) => l.role === "fee" && l.method === "timing")).toHaveLength(85);
  });

  it("identifies most payments from the comment rather than by guessing", () => {
    const identified = links.filter((l) => l.method === "agreement" || l.method === "reference").length;
    const guessed = links.filter((l) => l.method === "open_loan").length;
    expect(identified).toBeGreaterThan(560);
    expect(guessed).toBeLessThan(420); // early/late rows carry no identifier at all
  });

  it("leaves unlinked only legacy-mortgage rows and fees not charged with a disbursement", () => {
    const borrowers = new Set(loans.map((l) => l.borrowerStateId));
    const fromLoanBorrowers = unlinked.filter((r) => r.initiatorStateId !== null && borrowers.has(r.initiatorStateId));
    // e.g. a $5,000 mortgage broker fee from someone who only took a loan months later.
    expect(fromLoanBorrowers.every((r) => r.category === "loan.origination_fee" && r.amountCents > 100)).toBe(true);
    expect(fromLoanBorrowers).toHaveLength(1);
  });
});

describe("two overlapping loans to one borrower (early 'total repayable' comments)", () => {
  // Modelled on a real case: $20,000 at 20% over 8 (comments say $24,000) and $15,000 over 7, opened ten days apart.
  const t = (iso: string) => new Date(iso);
  const row = (id: string, at: string, category: LinkableRow["category"], comment: string, amount: number): LinkableRow => ({
    id,
    occurredAt: t(at),
    category,
    comment,
    amountCents: amount * 100,
    initiatorStateId: 777,
  });
  const rows: LinkableRow[] = [
    row("A", "2026-03-30T06:51:58Z", "loan.disbursement", "Loan Transfer x", 20000),
    row("B", "2026-04-09T05:19:01Z", "loan.disbursement", "Loan Transfer y", 15000),
    row("a1", "2026-04-06T07:46:26Z", "loan.principal", "Subscription payment Loan Agreement Amount: $240001/8", 2475),
    row("a1i", "2026-04-06T07:46:26Z", "loan.interest", "Broker percentage payment: Loan Agreement Amount: $24000 ID: aaaaaaaaaaaaaaaaaaaaaaaa", 500),
    row("a2i", "2026-04-14T07:05:26Z", "loan.interest", "Broker percentage payment: OVERDUE: Missed payment 1/8 (1 missed) ID: aaaaaaaaaaaaaaaaaaaaaaaa", 510),
    row("a2", "2026-04-14T07:05:26Z", "loan.late_principal", "Late Finance Repayment", 2524),
    row("b1", "2026-04-18T07:58:16Z", "loan.late_principal", "Late Finance Repayment", 2164),
    row("b1i", "2026-04-18T07:58:16Z", "loan.interest", "Broker percentage payment: OVERDUE: Missed payment 0/7 (1 missed) ID: bbbbbbbbbbbbbbbbbbbbbbbb", 372),
    row("b2", "2026-05-05T06:55:19Z", "loan.principal", "Subscription payment OVERDUE: Missed payment 1/7 (1 missed)3/7", 2209),
    row("a3", "2026-05-12T04:54:33Z", "loan.principal", "Subscription payment OVERDUE: Missed payment 3/8 (1 missed)5/8", 2576),
  ];
  const { links } = linkPayments(rows);
  const loanOf = (id: string) => links.find((l) => l.txId === id)?.disbursementTxId;

  it("reads the total repayable as the $20,000 loan", () => {
    expect(agreementFits(2_400_000, 2_000_000)).toBe("total");
    expect(agreementFits(2_400_000, 1_500_000)).toBeNull(); // 60% isn't a loan rate
    expect(loanOf("a1")).toBe("A");
    expect(loanOf("a1i")).toBe("A");
  });

  it("tells the loans apart by agreement ID and instalment count, and pairs same-second rows", () => {
    expect(["a2i", "a2", "a3"].map(loanOf)).toEqual(["A", "A", "A"]);
    expect(["b1", "b1i", "b2"].map(loanOf)).toEqual(["B", "B", "B"]);
    expect(links.find((l) => l.txId === "a2")?.method).toBe("paired");
    expect(links.find((l) => l.txId === "b2")?.method).toBe("instalments");
  });
});
