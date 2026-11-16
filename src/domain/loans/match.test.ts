import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classify } from "@/domain/bank/classify";
import { parseBankExport } from "@/domain/bank/parse-export";
import { deriveLoans, linkPayments } from "./link";
import { finalInstalment, instalmentsFromComment, matchCards, problemForNewLoan, type CandidateLoan, type CardMatch } from "./match";
import { parseCards } from "./parse-cards";

const parsed = parseBankExport(readFileSync("tests/fixtures/bank-export.xlsx"));
const rows = parsed.rows.map((r, i) => ({
  id: String(i),
  occurredAt: r.occurredAt,
  category: classify(r).category,
  comment: r.comment,
  amountCents: r.amountCents,
  initiatorStateId: r.initiatorStateId,
}));
const loans = deriveLoans(rows);
const { links } = linkPayments(rows, loans);
const candidates: CandidateLoan[] = loans.map((l) => {
  const mine = links.filter((x) => x.disbursementTxId === l.disbursementTxId);
  const returned = mine
    .filter((x) => x.role === "principal" || x.role === "early_principal" || x.role === "late_principal")
    .reduce((s, x) => s + rows[Number(x.txId)].amountCents, 0);
  const ns = mine.filter((x) => x.role === "principal").map((x) => instalmentsFromComment(rows[Number(x.txId)].comment));
  return {
    id: l.disbursementTxId,
    borrowerStateId: l.borrowerStateId,
    principalCents: l.principalCents,
    openedAt: l.openedAt,
    observedInstalments: ns.filter((n): n is number => n !== null).at(-1) ?? null,
    returnedRatio: returned / l.principalCents,
    paidUp: mine.some((x) => x.role === "principal" && finalInstalment(rows[Number(x.txId)].comment, [l.principalCents / 100])),
  };
});

function run(tab: string): CardMatch[] {
  return matchCards(parseCards(readFileSync(`tests/fixtures/paste-${tab}.txt`, "utf8")).cards, candidates);
}
const tally = (res: CardMatch[]) =>
  res.reduce<Record<string, number>>((m, r) => {
    const k = r.kind === "matched" ? "matched" : r.kind === "ignored" ? `ignored:${r.reason}` : r.kind;
    return { ...m, [k]: (m[k] ?? 0) + 1 };
  }, {});

describe("matching the anonymised pastes to bank-derived loans", () => {
  it("matches every Active and Overdue card", () => {
    expect(tally(run("active"))).toEqual({ matched: 14 });
    expect(tally(run("overdue"))).toEqual({ matched: 1 });
  });

  it("matches defaulted loans and ignores sanctioned legacy mortgages", () => {
    expect(tally(run("default"))).toEqual({ matched: 17, "ignored:legacy_mortgage": 4 });
  });

  it("matches completed loans, including the early 'total repayable' agreement format", () => {
    const res = run("complete");
    expect(tally(res)).toEqual({ matched: 53, "ignored:legacy_mortgage": 13 });
    expect(res.filter((r) => r.kind === "matched" && r.how === "agreement_total").length).toBeGreaterThan(10);
  });

  it("never matches two cards of one paste to the same loan", () => {
    for (const tab of ["active", "default", "complete"]) {
      const ids = run(tab).flatMap((r) => (r.kind === "matched" ? [r.loanId] : []));
      expect(new Set(ids).size, tab).toBe(ids.length);
    }
  });

  it("only matches a card to its own borrower's loan", () => {
    const owner = new Map(candidates.map((c) => [c.id, c.borrowerStateId]));
    for (const tab of ["active", "overdue", "default", "complete"]) {
      for (const r of run(tab)) if (r.kind === "matched") expect(owner.get(r.loanId)).toBe(r.card.stateId);
    }
  });
});

describe("matchCards edge cases", () => {
  const base = parseCards("$100.00\n69811362\n4242\nTYPE loan\nBroker interest rate 20 %\n1/4complete\nOVERDUE: Missed payment 1/4 (1 missed)").cards[0];
  const loan = (id: string, openedAt: string, returnedRatio = 0.5): CandidateLoan => ({
    id,
    borrowerStateId: 4242,
    principalCents: 1_000_000,
    openedAt: new Date(openedAt),
    observedInstalments: 4,
    returnedRatio,
  });

  it("asks the user when two open loans fit equally", () => {
    const [res] = matchCards([base], [loan("a", "2026-05-01"), loan("b", "2026-06-01")]);
    expect(res).toMatchObject({ kind: "ambiguous", candidateIds: ["a", "b"] });
  });

  it("prefers the open loan over a repaid one for a live card", () => {
    const [res] = matchCards([base], [loan("old", "2026-01-01", 1), loan("live", "2026-06-01", 0.4)]);
    expect(res).toMatchObject({ kind: "matched", loanId: "live" });
  });

  it("reports a card with no disbursement as new", () => {
    expect(matchCards([{ ...base, stateId: 9999 }], [loan("a", "2026-05-01")])[0]).toMatchObject({ kind: "new" });
  });

  it("counts the same card pasted twice once, so it can't become a second loan", () => {
    const again = { ...base, index: 1, raw: `${base.raw}\n` };
    const res = matchCards([{ ...base, stateId: 9999 }, { ...again, stateId: 9999 }], []);
    expect(res.map((r) => r.kind)).toEqual(["new", "ignored"]);
    expect(res[1]).toMatchObject({ reason: "duplicate_card" });
  });

  it("only lets a card that states its amount start a new loan", () => {
    expect(problemForNewLoan({ ...base, principalCents: 1_000_000 })).toBeNull();
    expect(problemForNewLoan(base)).toMatch(/doesn’t state the loan amount/); // an Overdue card
  });
});
