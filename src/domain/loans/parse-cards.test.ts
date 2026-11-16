import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCards, parseGameDate } from "./parse-cards";

const read = (tab: string) => readFileSync(`tests/fixtures/paste-${tab}.txt`, "utf8");

describe("parseCards on the anonymised pastes", () => {
  it.each([
    ["active", 14],
    ["overdue", 1],
    ["default", 21],
    ["complete", 66],
  ])("%s tab: %i cards, every line recognised", (tab, count) => {
    const { cards, ignoredLines } = parseCards(read(tab));
    expect(cards).toHaveLength(count);
    expect(ignoredLines).toEqual([]);
    // Rate warnings are about the loan, not the parsing (8 finished loans had the State's rate above the broker's).
    expect(cards.flatMap((c) => c.warnings).filter((w) => !w.includes("higher than the broker rate"))).toEqual([]);
    if (tab === "complete") expect(cards.filter((c) => c.warnings.some((w) => w.includes("higher than the broker rate")))).toHaveLength(8);
  });

  it("reads a full Active card", () => {
    const [first] = parseCards(read("active")).cards;
    expect(first).toMatchObject({
      headerAmountCents: 18_100,
      wallet: "69811362",
      type: "loan",
      stateRatePct: 1,
      brokerRatePct: 15,
      originalTotalRatePct: 16,
      currentTotalRatePct: 16,
      rateDeltaPct: 0,
      missedPayments: 0,
      remainingCents: 31_300,
      completed: 4,
      instalments: 6,
      nextPaymentIn: { value: 2, unit: "hours" },
      periodDays: 7,
      principalCents: 4_000_000,
      status: "ok",
      action: null,
    });
  });

  it("reads an overdue card with its first missed payment", () => {
    const [card] = parseCards(read("overdue")).cards;
    expect(card).toMatchObject({ status: "overdue", missedPayments: 1, rateDeltaPct: 2, completed: 3, instalments: 10, principalCents: null });
    expect(card.firstMissedAt?.toISOString()).toBe("2026-10-08T23:03:01.000Z"); // 9 Oct 00:03:01 GMT+1
    expect(card.statusText).toBe("OVERDUE: Missed payment 3/10 (1 missed)");
  });

  it("distinguishes defaulted loans from sanctioned legacy mortgages", () => {
    const { cards } = parseCards(read("default"));
    const loans = cards.filter((c) => c.type === "loan");
    const mortgages = cards.filter((c) => c.type === "mortgage");
    expect(loans.every((c) => c.status === "defaulted" || c.status === "overdue")).toBe(true);
    expect(loans.filter((c) => c.action === "move_to_overdue")).toHaveLength(loans.length);
    expect(mortgages.every((c) => c.wallet === "69794349" && c.status === "sanctioned" && c.action === "repay_in_full")).toBe(true);
  });

  it("accepts the game's typo'd default line and float residues", () => {
    const { cards } = parseCards(read("complete"));
    expect(cards.some((c) => c.statusText?.includes("missed to many missed payments! {{comment}}"))).toBe(true);
    expect(cards.find((c) => c.remainingCents === 788_000)).toBeDefined(); // "$7879.714285714291) remaining" → $7,880
    expect(cards.filter((c) => c.mortgageAddress)).not.toHaveLength(0);
  });
});

describe("parseGameDate", () => {
  it.each([
    ["9 April 2026 - 05:44:25 PM (GMT+1)", "2026-04-09T16:44:25.000Z"],
    ["October 9, 2026 - 12:03:01 AM (GMT+1)", "2026-10-08T23:03:01.000Z"],
    ["1 July 2026 - 12:30:00 PM (GMT+0)", "2026-07-01T12:30:00.000Z"],
  ])("%s", (input, iso) => {
    expect(parseGameDate(input)?.toISOString()).toBe(iso);
  });

  it("rejects nonsense", () => {
    expect(parseGameDate("next Tuesday")).toBeNull();
  });
});

describe("parseCards robustness", () => {
  it("ignores text before the first card and keeps unknown lines as warnings", () => {
    const text = "Business Subscriptions\nACTIVE\n$100.00\n69811362\n1234\nTYPE loan\nSomething new the game added\n1/2complete";
    const { cards, ignoredLines } = parseCards(text);
    expect(ignoredLines).toEqual(["Business Subscriptions", "ACTIVE"]);
    expect(cards[0].warnings).toEqual(["Unrecognised line: Something new the game added"]);
  });

  it("returns no cards for empty input", () => {
    expect(parseCards("   \n\n").cards).toEqual([]);
  });
});

describe("rates that lose money", () => {
  it("warns when the State's rate is above the broker rate (entered the wrong way round?)", () => {
    const [card] = parseCards("$75,000.00\n69811362\n23088\nTYPE loan\nState interest rate 15 %\nBroker interest rate 1 %\n1/8complete").cards;
    expect(card.warnings).toContainEqual(expect.stringMatching(/State rate 15% is higher than the broker rate 1%/));
    const [fine] = parseCards("$75,000.00\n69811362\n23088\nTYPE loan\nState interest rate 1 %\nBroker interest rate 15 %\n1/8complete").cards;
    expect(fine.warnings.some((w) => w.includes("higher than the broker rate"))).toBe(false);
  });
});
