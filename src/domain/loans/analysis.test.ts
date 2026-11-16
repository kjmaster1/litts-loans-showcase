import { describe, expect, it } from "vitest";
import { wholeDollars } from "@/lib/money";
import { analyseLoan, contractSchedule, levyFor, nextPaymentDue, penaltyFor, type LinkedPayment, type LoanTerms } from "./analysis";

const at = (iso: string) => new Date(iso);
// The research/02 example: $40,000 over 6 weeks, 15% broker + 1% state.
const terms: LoanTerms = { principalCents: 4_000_000, instalments: 6, periodDays: 7, brokerRate: 0.15, stateRate: 0.01, openedAt: at("2026-09-04T13:14:38Z") };

describe("contractSchedule", () => {
  it("splits principal into equal instalments that sum exactly", () => {
    const s = contractSchedule(terms);
    expect(s).toHaveLength(6);
    expect(s.reduce((sum, r) => sum + r.principalCents, 0)).toBe(4_000_000);
    // Whole dollars like the game: $6,666.67 → $6,667; the last instalment takes the remainder.
    expect(s[0]).toMatchObject({ number: 1, principalCents: 666_700, interestCents: 100_000, borrowerPaysCents: 766_700 });
    expect(s[5].principalCents).toBe(666_500);
    expect(s.every((r) => r.principalCents % 100 === 0 && r.interestCents % 100 === 0)).toBe(true);
    expect(s[0].dueAt.toISOString()).toBe("2026-09-11T13:14:38.000Z");
  });
});

describe("levyFor", () => {
  it("recovers the State's 1% from a regular instalment", () => {
    // Company received $6,600 of a $6,666.67 instalment → State kept ~$66.67.
    expect(levyFor("principal", 660_000, terms)).toBe(6_700); // $66.67 → whole dollars like the game
  });

  it("is zero on an early repayment: the State's share is the borrower's cost, not Litt's", () => {
    // $20,000 paid early → $16,800 credited to the loan, $3,000 interest, $200 to the State on top.
    expect(levyFor("early_principal", 1_680_000, terms)).toBe(0);
  });

  it("is zero for 0% state loans and for interest", () => {
    expect(levyFor("principal", 660_000, { ...terms, stateRate: 0 })).toBe(0);
    expect(levyFor("interest", 100_000, terms)).toBe(0);
  });
});

describe("analyseLoan — the real bug pattern from research/02", () => {
  // Two regular instalments, then three early repayments that each over-charge
  // interest (game credits X(1−b−s) principal, charges Xb interest), then two
  // small instalments re-spread over the remaining term.
  const payments: LinkedPayment[] = [
    { txId: "p1", role: "principal", amountCents: 660_000, occurredAt: at("2026-09-11T13:23:20Z") },
    { txId: "i1", role: "interest", amountCents: 100_000, occurredAt: at("2026-09-11T13:23:20Z") },
    { txId: "p2", role: "principal", amountCents: 660_100, occurredAt: at("2026-09-18T14:03:17Z") },
    { txId: "i2", role: "interest", amountCents: 100_000, occurredAt: at("2026-09-18T14:03:17Z") },
    { txId: "e1", role: "early_principal", amountCents: 1_680_000, occurredAt: at("2026-09-22T10:21:21Z") },
    { txId: "x1", role: "early_interest", amountCents: 300_000, occurredAt: at("2026-09-22T10:21:21Z") },
    { txId: "e2", role: "early_principal", amountCents: 672_000, occurredAt: at("2026-09-22T11:35:42Z") },
    { txId: "x2", role: "early_interest", amountCents: 120_000, occurredAt: at("2026-09-22T11:35:42Z") },
    { txId: "e3", role: "early_principal", amountCents: 252_000, occurredAt: at("2026-09-22T11:36:31Z") },
    { txId: "x3", role: "early_interest", amountCents: 45_000, occurredAt: at("2026-09-22T11:36:31Z") },
    { txId: "p3", role: "principal", amountCents: 15_500, occurredAt: at("2026-09-25T14:32:46Z") },
    { txId: "p4", role: "principal", amountCents: 15_500, occurredAt: at("2026-10-02T15:03:40Z") },
    { txId: "p5", role: "principal", amountCents: 15_500, occurredAt: at("2026-10-09T15:42:39Z") },
  ];
  const a = analyseLoan(terms, payments);

  it("flags the early-repayment interest overcharge", () => {
    // Fair interest is 15% of principal credited: 252,000 + 100,800 + 37,800 = 390,600.
    // Charged 465,000 → overcharged $744.
    const flag = a.flags.find((f) => f.kind === "early_overcharge");
    expect(flag?.cents).toBe(465_000 - 390_600);
  });

  it("books the State's share of regular instalments only, and agrees with the phone", () => {
    expect(a.principalReceivedCents).toBe(3_970_600);
    // $67 + $67 on the two full instalments, $2 on each of the three small ones; none on the early repayments.
    expect(a.levyCents).toBe(14_000);
    // Onyx Greystone's card (13 Oct, 5/6 complete) says "$156 remaining". The app makes it $154: the game
    // keeps cents on each instalment ($6,666.67) where the levy is whole dollars. It used to say −$156.
    expect(a.outstandingCents).toBe(15_400);
    expect(Math.abs(a.outstandingCents - 15_600)).toBeLessThanOrEqual(300);
    expect(a.flags.find((f) => f.kind === "overpaid")).toBeUndefined();
    expect(a.instalmentsPaid).toBe(5);
  });

  it("flags interest charged with no principal credited", () => {
    const orphan = analyseLoan(terms, [{ txId: "x", role: "early_interest", amountCents: 161_000, occurredAt: at("2026-09-27T09:49:46Z") }]);
    expect(orphan.flags).toContainEqual({ kind: "interest_without_principal", source: "game", cents: 161_000, detail: "1 early-interest charge(s) with no principal credited" });
  });

  it("flags a loan that collected more principal than was lent", () => {
    const over = analyseLoan({ ...terms, stateRate: 0 }, [{ txId: "p", role: "principal", amountCents: 5_000_000, occurredAt: at("2026-09-11T00:00:00Z") }]);
    expect(over.flags.find((f) => f.kind === "overpaid")?.cents).toBe(1_000_000);
  });

  it("raises no flags for a clean loan repaid on schedule", () => {
    const clean = analyseLoan(
      terms,
      contractSchedule(terms).flatMap((r, i) => [
        { txId: `p${i}`, role: "principal" as const, amountCents: wholeDollars(r.principalCents * 0.99), occurredAt: r.dueAt },
        { txId: `i${i}`, role: "interest" as const, amountCents: r.interestCents, occurredAt: r.dueAt },
      ]),
    );
    expect(clean.flags).toEqual([]);
    expect(clean.outstandingCents).toBe(0);
  });

  it("marks the game's missing interest on the final instalment", () => {
    const rows = contractSchedule(terms);
    expect(rows.map((r) => r.interestCharged)).toEqual([true, true, true, true, true, false]);
    const paid = analyseLoan(
      terms,
      rows.flatMap((r, i) => [
        { txId: `p${i}`, role: "principal" as const, amountCents: wholeDollars(r.principalCents * 0.99), occurredAt: r.dueAt },
        ...(r.interestCharged ? [{ txId: `i${i}`, role: "interest" as const, amountCents: r.interestCents, occurredAt: r.dueAt }] : []),
      ]),
    );
    expect(paid.flags).toEqual([{ kind: "final_interest_not_charged", source: "game", cents: rows[5].interestCents, detail: "The game didn't charge interest on the final instalment" }]);
  });

  it("warns when the State's rate is above the broker rate (Tatum Galloway's second loan)", () => {
    const swapped = analyseLoan({ ...terms, principalCents: 7_500_000, instalments: 8, brokerRate: 0.01, stateRate: 0.15 }, []);
    expect(swapped.flags).toEqual([expect.objectContaining({ kind: "loss_making_rates", source: "setup", cents: 1_050_000 })]);
    expect(swapped.flags[0].detail).toMatch(/State's rate \(15%\) is higher than the broker rate \(1%\)/);
  });
});

describe("instalments paid and the game's due dates (QA 2026-10-13, Ridley Thornbury's live loan)", () => {
  // $55,000 over 12 weeks at 15% + 1%: six on time, then the 7th and 8th each paid late.
  const morgan: LoanTerms = { principalCents: 5_500_000, instalments: 12, periodDays: 7, brokerRate: 0.15, stateRate: 0.01, openedAt: at("2026-08-15T10:25:21Z") };
  const onTime = ["2026-08-22T11:03:11Z", "2026-08-29T11:13:11Z", "2026-09-05T11:58:54Z", "2026-09-12T12:20:40Z", "2026-09-19T13:07:12Z", "2026-09-26T14:02:59Z"];
  const payments: LinkedPayment[] = [
    ...onTime.map((iso, i) => ({ txId: `p${i}`, role: "principal" as const, amountCents: 453_800, occurredAt: at(iso) })),
    { txId: "l1", role: "late_principal", amountCents: 462_900, occurredAt: at("2026-10-04T11:26:52Z") },
    { txId: "l2", role: "late_principal", amountCents: 472_200, occurredAt: at("2026-10-12T13:18:05Z") },
  ];
  const a = analyseLoan(morgan, payments);

  it("counts a late repayment as the instalment it pays, like the phone (8/12)", () => {
    expect(a.instalmentsPaid).toBe(8);
  });

  it("dates each instalment a period after the previous payment, as the game does", () => {
    // The contract says the 9th is due 17 Oct; the phone (13 Oct, "in 6 days") says 19 Oct.
    expect(a.schedule[8].dueAt.toISOString()).toBe("2026-10-17T10:25:21.000Z");
    expect(a.gameDueAt[8].toISOString()).toBe("2026-10-19T13:18:05.000Z");
    expect(a.gameDueAt[0].toISOString()).toBe("2026-08-22T10:25:21.000Z");
    expect(a.gameDueAt[1].toISOString()).toBe("2026-08-29T11:03:11.000Z");
    // Not yet paid: each a period after the one before.
    expect(a.gameDueAt[9].toISOString()).toBe("2026-10-26T13:18:05.000Z");
  });

  it("an early repayment neither counts as an instalment nor moves the dates", () => {
    const withEarly = analyseLoan(morgan, [...payments, { txId: "e", role: "early_principal", amountCents: 100_000, occurredAt: at("2026-10-13T09:00:00Z") }]);
    expect(withEarly.instalmentsPaid).toBe(8);
    expect(withEarly.gameDueAt).toEqual(a.gameDueAt);
  });

  it("splits the +2% overdue penalty out of the late instalments (owner 2026-10-13: a late fee)", () => {
    expect(penaltyFor("late_principal", 462_900, morgan)).toBe(9_100); // $4,538 × 1.02
    expect(penaltyFor("late_principal", 472_200, morgan)).toBe(18_400); // × 1.02², compounded
    expect(penaltyFor("principal", 453_800, morgan)).toBe(0);
    expect(a.penaltyCents).toBe(27_500);
  });
});

describe("overdue penalty (audit F5; owner 2026-10-13: booked as a late fee) — Winter Holloway's live loan", () => {
  // $40,000 over 8 weeks at 18% + 1%: instalment 3 missed and paid late, instalment 4 on time — both with +2%.
  const winter: LoanTerms = { principalCents: 4_000_000, instalments: 8, periodDays: 7, brokerRate: 0.18, stateRate: 0.01, openedAt: at("2026-09-13T09:26:15Z") };
  const payments: LinkedPayment[] = [
    { txId: "p1", role: "principal", amountCents: 495_000, occurredAt: at("2026-09-20T09:45:04Z") },
    { txId: "p2", role: "principal", amountCents: 495_000, occurredAt: at("2026-09-27T10:42:44Z") },
    { txId: "l3", role: "late_principal", amountCents: 504_900, occurredAt: at("2026-10-04T11:04:26Z") },
    { txId: "p4", role: "principal", amountCents: 504_900, occurredAt: at("2026-10-11T11:51:23Z") },
  ];
  const a = analyseLoan(winter, payments);

  it("is found from the money, not the comment", () => {
    expect(penaltyFor("principal", 504_900, winter)).toBe(9_900);
    expect(penaltyFor("principal", 495_000, winter)).toBe(0);
    expect(penaltyFor("principal", 495_100, winter)).toBe(0); // a dollar of rounding is not a penalty
    expect(penaltyFor("early_principal", 504_900, winter)).toBe(0);
    expect(penaltyFor("principal", 15_500, winter)).toBe(0); // shrunk by an early repayment
  });

  it("leaves the principal still owed — the phone's figure without the penalty to come", () => {
    expect(a.penaltyCents).toBe(19_800);
    // Levy on the instalment itself ($50), not on the penalty.
    expect(a.levyCents).toBe(20_000);
    expect(a.outstandingCents).toBe(2_000_000);
    // The card (13 Oct): "$20400) remaining" — the same $20,000 with the game's 2% on what's still to pay.
    expect(Math.round(a.outstandingCents * 1.02)).toBe(2_040_000);
    expect(a.instalmentsPaid).toBe(4);
  });
});

describe("next payment (13 Oct 2026: the same phone text pasted 1 h 45 m apart)", () => {
  const weekly = (openedAt: string, instalments: number) => ({ openedAt: at(openedAt), periodDays: 7, instalments });
  // The 02:23 paste repeated the 00:38 text, so its countdowns put the next payment 1 h 45 m late.
  const stale = (hours: number) => ({ estimate: new Date(at("2026-10-13T02:23:46Z").getTime() + hours * 3_600_000) });

  it("is the game's due date from the bank, not the card's countdown", () => {
    // Greer Marlowe: opened 7 Oct 00:07, nothing paid yet. Card said "in 23 hours" at 00:38 (true: 23 h 29 m).
    expect(nextPaymentDue(weekly("2026-10-07T00:07:18Z", 6), [], { completed: 0, ...stale(23) })?.toISOString()).toBe("2026-10-14T00:07:18.000Z");
    // Oakley Coldwell: paid instalment 1 on 6 Oct 22:50, so the next is due a week after that.
    expect(nextPaymentDue(weekly("2026-09-29T21:56:07Z", 24), [at("2026-10-06T22:50:16Z")], { completed: 1, ...stale(22) })?.toISOString()).toBe(
      "2026-10-13T22:50:16.000Z",
    );
  });

  it("takes the card's estimate while the bank hasn't seen a payment the phone counts", () => {
    const estimate = at("2026-10-20T23:00:00Z");
    expect(nextPaymentDue(weekly("2026-09-29T23:35:00Z", 5), [at("2026-10-06T23:50:51Z")], { completed: 2, estimate })).toBe(estimate);
  });

  it("is none once every instalment is paid", () => {
    expect(nextPaymentDue(weekly("2026-10-07T00:00:00Z", 1), [at("2026-10-14T00:10:00Z")], { completed: 1, estimate: null })).toBeNull();
  });
});
