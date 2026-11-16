import { readFileSync } from "node:fs";
import { and, eq, ne } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/request", () => ({ getRequestMeta: async () => ({ ip: "203.0.113.10", userAgent: "vitest" }) }));

const { commitImport, stageImport } = await import("@/server/bank/import");
const { syncLoans } = await import("@/server/loans/sync");
const { canActOnOffer, cancelOffer, createOffer, getOffer, issueOffer, linkOffer, listOffers, loanCandidates, unlinkOffer, updateOffer, borrowerForOffer } = await import("@/server/origination/loan-offers");
const { canActOnQuote, saveQuote, getQuote, cancelQuote, listQuotes } = await import("@/server/origination/mortgage-quotes");
const { db } = await import("@/server/db");
const { auditEvent, loan, loanOffer, staff } = await import("@/server/db/schema");
const { resetDb } = await import("../support/db");

type Viewer = import("@/server/authz/viewer").Viewer;
let ceo: Viewer;
let officer: Viewer;
let other: Viewer;

async function makeViewer(stateId: number, name: string, role: Viewer["role"]): Promise<Viewer> {
  const [row] = await db.insert(staff).values({ stateId, characterName: name, role, status: "active" }).returning();
  return { staffId: row.id, userId: `u-${stateId}`, sessionId: `s-${stateId}`, role, characterName: name, stateId, username: name, twoFactorEnabled: true, stepUpAt: null, tourCompletedAt: null, tourRole: null };
}

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
const offer = (over: Record<string, unknown> = {}) => ({
  kind: "property" as const,
  borrowerStateId: 40001,
  borrowerName: "Avery Lane",
  amountDollars: 130_000,
  ratePct: 15,
  stateRatePct: 1,
  weeks: 24,
  startsOn: today(),
  collateral: "103 South Rockford Dr",
  collateralValueDollars: 200_000,
  weeklyIncomeDollars: 20_000,
  defaultFeePerDayDollars: 1_000,
  ...over,
});

beforeAll(async () => {
  await resetDb();
  ceo = await makeViewer(3454, "Kieran Jones", "ceo");
  officer = await makeViewer(70001, "Ola Officer", "loan_officer");
  other = await makeViewer(70002, "Otto Other", "loan_officer");
  await commitImport(ceo, await stageImport(ceo, { name: "export.xlsx", bytes: readFileSync("tests/fixtures/bank-export.xlsx") }));
});

describe("loan offers", () => {
  it("are made by officers as drafts, checked, then issued with a frozen contract", async () => {
    await expect(createOffer(officer, offer({ startsOn: "2020-01-01" }))).rejects.toThrow(/can’t be in the past/);
    await expect(createOffer(officer, offer({ collateral: "" }))).rejects.toThrow(/make & model or the property’s address/);
    const id = await createOffer(officer, offer());
    await updateOffer(officer, id, offer({ ratePct: 14 }));
    await expect(updateOffer(other, id, offer())).rejects.toThrow(/officer or management/);
    // Colleagues see each other's offers (owner, 2026-10-11) but can't change them.
    expect((await getOffer(other, id))!.officerStaffId).toBe(officer.staffId);
    expect(canActOnOffer(other, (await getOffer(other, id))!)).toBe(false);
    await expect(issueOffer(other, id)).rejects.toThrow(/officer or management/);
    await expect(cancelOffer(other, { id, reason: "Not mine to cancel" })).rejects.toThrow(/officer or management/);

    await issueOffer(officer, id);
    const o = (await getOffer(officer, id))!;
    expect(o.status).toBe("issued");
    expect(o.contractText).toContain("LITT'S LOANS PROPERTY LOAN AGREEMENT");
    expect(o.contractText).toContain("Interest Rate: 14% interest on loan amount");
    expect(o.contractText).toContain("Total Repayment Amount: $148,200");
    expect(o.contractText).toContain("LENDER: Litt's Loans Representative: Ola Officer [70001]");
    await expect(updateOffer(officer, id, offer())).rejects.toThrow(/Only a draft/);

    await cancelOffer(officer, { id, reason: "Borrower changed their mind" });
    expect((await getOffer(ceo, id))!.status).toBe("cancelled"); // management sees all
    const actions = (await db.select({ a: auditEvent.action }).from(auditEvent).where(eq(auditEvent.targetId, id))).map((r) => r.a);
    expect(actions).toEqual(expect.arrayContaining(["loans.offer.created", "loans.offer.updated", "loans.offer.issued", "loans.offer.cancelled"]));
    expect((await listOffers(other, {})).length).toBe(1);
    expect((await listOffers(other, { mine: true })).length).toBe(0);
  });

  it("knows the borrower's record for the rate guide", async () => {
    // No phone cards pasted here, so every loan from the bank is still running.
    const [someone] = await db.select().from(loan).limit(1);
    const b = await borrowerForOffer(officer, someone.borrowerStateId);
    expect(b.record.open).toBeGreaterThan(0);
    expect(b.name).toBe(someone.borrowerName);
    expect(b.check.flags.length).toBeGreaterThan(0);
  });

  it("is linked to the loan the game paid out (same borrower and amount, around the contract date)", async () => {
    const [paid] = await db.select().from(loan).orderBy(loan.openedAt).limit(1);
    // An offer issued for that loan before it was paid out (inserted directly: contracts can't be back-dated).
    const [row] = await db
      .insert(loanOffer)
      .values({
        kind: "general",
        status: "issued",
        borrowerStateId: paid.borrowerStateId,
        borrowerName: paid.borrowerName ?? "Someone",
        officerStaffId: officer.staffId,
        amountCents: paid.principalCents,
        rateBp: 1500,
        stateRateBp: 100,
        weeks: 4,
        startsOn: new Date(paid.openedAt!.getTime() - 3_600_000),
        defaultFeePerDayCents: 50_000,
        purchaseDays: 3,
        detailsHours: 72,
        extraHours: 24,
        defaultAfterDays: 7,
        createdByStaffId: officer.staffId,
      })
      .returning();
    await syncLoans();
    const [after] = await db.select().from(loanOffer).where(and(eq(loanOffer.id, row.id)));
    expect(after).toMatchObject({ status: "funded", loanId: paid.id });

    // A wrong match is unlinked by hand ("not this loan") and never matched to it again.
    await expect(unlinkOffer(other, { id: row.id, reason: "Not mine to change" })).rejects.toThrow(/officer or management/);
    await unlinkOffer(officer, { id: row.id, reason: "Two loans the same size; wrong one" });
    await syncLoans();
    const [unlinked] = await db.select().from(loanOffer).where(eq(loanOffer.id, row.id));
    expect(unlinked).toMatchObject({ status: "issued", loanId: null, excludedLoanIds: [paid.id] });
    expect((await loanCandidates(officer, row.id)).map((c) => c.id)).toContain(paid.id);

    // ...and linked by hand: only to the borrower's own loans, and not one another offer holds.
    const [stranger] = await db.select().from(loan).where(ne(loan.borrowerStateId, paid.borrowerStateId)).limit(1);
    await expect(linkOffer(officer, { id: row.id, loanId: stranger.id, reason: "Trying the wrong person" })).rejects.toThrow(/isn't this borrower's/);
    await linkOffer(officer, { id: row.id, loanId: paid.id, reason: "It was this one after all" });
    const [relinked] = await db.select().from(loanOffer).where(eq(loanOffer.id, row.id));
    expect(relinked).toMatchObject({ status: "funded", loanId: paid.id, excludedLoanIds: [] });
    const actions = (await db.select({ a: auditEvent.action }).from(auditEvent).where(eq(auditEvent.targetId, row.id))).map((r) => r.a);
    expect(actions).toEqual(expect.arrayContaining(["loans.offer.unlinked", "loans.offer.linked"]));
  });
});

describe("mortgage quotes", () => {
  it("are saved, figured like the tablet, and cancelled", async () => {
    const id = await saveQuote(officer, {
      buyerStateId: 1632,
      buyerName: "Jordan Ironside",
      address: "117 Invention Ct",
      priceDollars: 733_856,
      agencyCommissionDollars: 44_470,
      downPaymentPct: 10,
      termMonths: 12,
      fedRatePct: 3,
      brokerRatePct: 6,
      bankerFeePct: 5,
      primaryResidence: true,
    });
    const q = (await getQuote(officer, id))!;
    expect(q).toMatchObject({ status: "draft", priceCents: 73_385_600, bankerFeeBp: 500, companyFunded: false });
    // Colleagues see it and count it against the allowance, but can't change it.
    expect((await getQuote(other, id))!.address).toBe("117 Invention Ct");
    expect(canActOnQuote(other, q)).toBe(false);
    await expect(cancelQuote(other, { id, reason: "Not mine to cancel" })).rejects.toThrow(/officer or management/);
    expect((await listQuotes(other, { mine: true })).length).toBe(0);
    expect((await listQuotes(other, { status: "live" })).map((x) => x.id)).toEqual([id]);
    await cancelQuote(officer, { id, reason: "Bought elsewhere" });
    expect(await listQuotes(other, { status: "live" })).toEqual([]);
    expect((await getQuote(officer, id))!.status).toBe("cancelled");
  });

  it("can't be saved over the federal maximums by anyone; company-funded ones are exempt (owner, 2026-10-15)", async () => {
    // $689,386 down payment + loan: the band up to $1,000,000 — banker fee at most 5%, broker rate at most 10%.
    const terms = {
      buyerStateId: 1632,
      buyerName: "Jordan Ironside",
      address: "117 Invention Ct",
      priceDollars: 733_856,
      agencyCommissionDollars: 44_470,
      downPaymentPct: 10,
      termMonths: 12,
      fedRatePct: 3,
      brokerRatePct: 6,
      bankerFeePct: 8,
      primaryResidence: true,
    };
    await expect(saveQuote(officer, terms)).rejects.toThrow("Banker fee 8% is above the federal maximum of 5% for mortgages up to $1,000,000.");
    await expect(saveQuote(ceo, { ...terms, bankerFeePct: 5, brokerRatePct: 11 })).rejects.toThrow(/Broker rate 11% is above the federal maximum of 10%/);
    // An open quote can't be edited over them either.
    const ok = await saveQuote(officer, { ...terms, bankerFeePct: 5 });
    await expect(saveQuote(officer, terms, ok)).rejects.toThrow(/federal maximum/);
    expect((await getQuote(officer, ok))!.bankerFeeBp).toBe(500);
    // Company-funded: no maximums (its loan doesn't touch the State allowance: allowance-outlook.test.ts).
    const own = await saveQuote(officer, { ...terms, bankerFeePct: 8, brokerRatePct: 12, companyFunded: true });
    expect((await getQuote(officer, own))!).toMatchObject({ companyFunded: true, bankerFeeBp: 800 });
  });
});
