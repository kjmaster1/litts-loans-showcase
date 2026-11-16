import { readFileSync } from "node:fs";
import { and, count, eq, isNull } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/request", () => ({ getRequestMeta: async () => ({ ip: "203.0.113.10", userAgent: "vitest" }) }));

/**
 * Data-quality safeguards (2026-10-12): a tablet paste copied from the heading down became a
 * mortgage called "Sale Agreement - Financed" with no terms. Pastes now find the real address,
 * refuse incomplete new records, hold possible duplicates for a decision; Management+ can merge
 * a duplicate mortgage or retire a card-only loan; records the bank never confirms are flagged.
 */

const { commitImport, stageImport } = await import("@/server/bank/import");
const { commitTablet, previewTablet } = await import("@/server/mortgages/tablet");
const { mergeMortgage } = await import("@/server/mortgages/service");
const { getMortgage, listMortgages, mergedInto } = await import("@/server/mortgages/queries");
const { mortgageSyncPending } = await import("@/server/mortgages/sync");
const { commitPaste, previewPaste } = await import("@/server/loans/paste");
const { retireCardOnlyLoan } = await import("@/server/loans/service");
const { getLoan, listLoans, mergedLoanInto } = await import("@/server/loans/queries");
const { unconfirmedRecords } = await import("@/server/data-quality");
const { dashboard } = await import("@/server/dashboard");
const { notificationsFor } = await import("@/server/notifications");
const { StepUpRequiredError } = await import("@/server/auth/step-up");
const { db } = await import("@/server/db");
const { auditEvent, loan, loanCard, loanCollectionAction, loanEvent, mortgage, mortgageEvent, mortgagePaste, mortgageSnapshot, staff } = await import("@/server/db/schema");
const { resetDb } = await import("../support/db");

type Viewer = import("@/server/authz/viewer").Viewer;
const SAMPLE = readFileSync("tests/fixtures/paste-mortgage.txt", "utf8");
const HEADING = "Sale Agreement - Financed\nPROPERTIES\nPAYMENTS\n";
const collapsed = (text: string) => text.replace(/Loan details\r?\n[\s\S]*?(?=Agency commission)/, "Loan details\n");
const fresh = (v: Viewer): Viewer => ({ ...v, stepUpAt: new Date().toISOString() });

let ceo: Viewer;
let officer: Viewer;

async function makeViewer(stateId: number, name: string, role: Viewer["role"]): Promise<Viewer> {
  const [row] = await db.insert(staff).values({ stateId, characterName: name, role, status: "active" }).returning();
  return { staffId: row.id, userId: `u-${stateId}`, sessionId: `s-${stateId}`, role, characterName: name, stateId, username: name, twoFactorEnabled: true, stepUpAt: null, tourCompletedAt: null, tourRole: null };
}

const mortgageCount = async () => (await db.select({ n: count() }).from(mortgage).where(isNull(mortgage.mergedIntoId)))[0].n;
const invention = async () => (await db.select().from(mortgage).where(eq(mortgage.address, "117 Invention Ct")))[0];

beforeAll(async () => {
  await resetDb();
  ceo = await makeViewer(424242, "Quality Tester", "ceo");
  officer = await makeViewer(3628, "Skyler Marlowe", "loan_officer");
  const stagingId = await stageImport(ceo, { name: "export.xlsx", bytes: readFileSync("tests/fixtures/bank-export.xlsx") });
  await commitImport(ceo, stagingId);
});

describe("tablet pastes", () => {
  it("copied from the tablet's heading still match by the real address", async () => {
    const before = await mortgageCount();
    const { items } = await previewTablet(ceo, { text: HEADING + SAMPLE });
    expect(items[0]).toMatchObject({ address: "117 Invention Ct", addressRecognised: true, skippedLines: ["Sale Agreement - Financed", "PROPERTIES", "PAYMENTS"] });
    expect(items[0].match).toMatchObject({ kind: "matched", how: "address, buyer and amounts" });
    expect(await commitTablet(ceo, { text: HEADING + SAMPLE })).toMatchObject({ updated: 1, created: 0, refused: 0 });
    expect(await mortgageCount()).toBe(before);
  });

  it("refuse to start a mortgage from an incomplete paste, but keep the paste", async () => {
    const before = await mortgageCount();
    const text = collapsed(SAMPLE.replace("117 Invention Ct", "999 Nowhere Ave").replace("#1632 Jordan Ironside", "#55555 Nobody Here"));
    const { items } = await previewTablet(ceo, { text });
    expect(items[0].match).toMatchObject({ kind: "refused" });
    expect(items[0].match.kind === "refused" && items[0].match.problems.join(" ")).toMatch(/Loan details/);
    expect(await commitTablet(ceo, { text })).toMatchObject({ created: 0, updated: 0, refused: 1 });
    expect(await mortgageCount()).toBe(before);
    const [{ n }] = await db.select({ n: count() }).from(mortgageSnapshot).where(isNull(mortgageSnapshot.mortgageId));
    expect(n).toBe(1); // the raw text is kept, attached to nothing
  });

  it("never match or rename a mortgage from a paste with no address", async () => {
    const text = SAMPLE.replace("117 Invention Ct", "Sale Agreement - Financed");
    const { items } = await previewTablet(ceo, { text });
    // Same buyer and price as 117 Invention Ct: offered as a possible duplicate, never matched by the heading.
    expect(items[0].match).toMatchObject({ kind: "possible_duplicate", newAllowed: false });
    const real = await invention();
    await expect(commitTablet(ceo, { text, decisions: { "0": "new" } })).rejects.toThrow(/can't be added as a new mortgage/);
    await commitTablet(ceo, { text, decisions: { "0": real.id } });
    expect((await invention()).address).toBe("117 Invention Ct"); // updated, not renamed
  });

  it("hold a possible duplicate until someone says which mortgage it is", async () => {
    const text = SAMPLE.replace("117 Invention Ct", "117 Invention Court");
    const before = await mortgageCount();
    const { items } = await previewTablet(ceo, { text });
    const real = await invention();
    expect(items[0].match).toMatchObject({ kind: "possible_duplicate", newAllowed: true, candidates: [expect.objectContaining({ id: real.id, address: "117 Invention Ct" })] });
    await expect(commitTablet(ceo, { text })).rejects.toThrow(/Say whether agreement 1/);
    await expect(commitTablet(ceo, { text, decisions: { "0": "00000000-0000-4000-8000-000000000000" } })).rejects.toThrow(/Say whether/);
    expect(await commitTablet(ceo, { text, decisions: { "0": "skip" } })).toMatchObject({ skipped: 1, created: 0, updated: 0 });
    expect(await mortgageCount()).toBe(before);
    expect((await invention()).address).toBe("117 Invention Ct");
  });
});

describe("merging a duplicate mortgage", () => {
  let junk: typeof mortgage.$inferSelect;

  beforeAll(async () => {
    // As made on 2026-10-12, before the safeguards: the heading as its address, no terms.
    const real = await invention();
    [junk] = await db
      .insert(mortgage)
      .values({
        address: "Sale Agreement - Financed",
        buyerStateId: real.buyerStateId,
        buyerName: real.buyerName,
        priceCents: real.priceCents,
        instalments: 52,
        funding: "company",
        lastTabletAt: new Date("2026-01-01T00:00:00Z"),
        createdAt: new Date("2026-01-01T00:00:00Z"),
      })
      .returning();
    const [p] = await db.insert(mortgagePaste).values({ count: 1, createdByStaffId: officer.staffId }).returning();
    await db.insert(mortgageSnapshot).values({ pasteId: p.id, mortgageId: junk.id, raw: HEADING + collapsed(SAMPLE), parsed: {} });
  });

  it("flags it while the bank data doesn't confirm it (dashboard, bell; Management+ only)", async () => {
    expect((await unconfirmedRecords()).map((r) => r.id)).toContain(junk.id);
    expect((await dashboard(ceo)).todos.find((t) => t.id === "unconfirmed")).toMatchObject({ href: `/mortgages/${junk.id}`, tone: "danger" });
    expect((await notificationsFor(ceo)).find((n) => n.key === `unconfirmed:mortgage:${junk.id}`)).toMatchObject({ kind: "unconfirmed_record" });
    expect((await notificationsFor(officer)).some((n) => n.kind === "unconfirmed_record")).toBe(false);
  });

  it("is Management+ only and needs a fresh step-up", async () => {
    const real = await invention();
    await expect(mergeMortgage(fresh(officer), { mortgageId: junk.id, intoId: real.id, reason: "Duplicate paste" })).rejects.toThrow(/permission/);
    await expect(mergeMortgage(ceo, { mortgageId: junk.id, intoId: real.id, reason: "Duplicate paste" })).rejects.toBeInstanceOf(StepUpRequiredError);
    await expect(mergeMortgage(fresh(ceo), { mortgageId: junk.id, intoId: real.id, reason: "x" })).rejects.toThrow(/reason/i);
  });

  it("refuses to merge away the record that holds the bank money, or one with a collections log", async () => {
    const real = await invention();
    const [other] = await db.select().from(mortgage).where(and(isNull(mortgage.mergedIntoId), eq(mortgage.address, "102 Sustancia Rd")));
    await expect(mergeMortgage(fresh(ceo), { mortgageId: real.id, intoId: other.id, reason: "Testing the guard" })).rejects.toThrow(/bank money/);
    // The collections log is append-only, so it couldn't follow the record.
    const [chased] = await db.insert(mortgage).values({ address: "1 Chased Lane", buyerStateId: real.buyerStateId, lastTabletAt: new Date() }).returning();
    await db.insert(loanCollectionAction).values({ mortgageId: chased.id, staffId: ceo.staffId, kind: "note", note: "Rang them" });
    await expect(mergeMortgage(fresh(ceo), { mortgageId: chased.id, intoId: real.id, reason: "Testing the guard" })).rejects.toThrow(/collections log/);
  });

  it("retires the duplicate into the real record, keeping its history", async () => {
    const real = await invention();
    await mergeMortgage(fresh(ceo), { mortgageId: junk.id, intoId: real.id, reason: "Pasted from the tablet heading by mistake" });

    const [after] = await db.select().from(mortgage).where(eq(mortgage.id, junk.id));
    expect(after.mergedIntoId).toBe(real.id);
    expect((await invention()).addressAliases).toEqual([]); // the heading is not a former address
    expect((await listMortgages(ceo, { status: "all" })).some((m) => m.id === junk.id)).toBe(false);
    expect(await getMortgage(ceo, junk.id)).toBeNull();
    expect(await mergedInto(junk.id)).toBe(real.id); // old links redirect
    const snaps = await db.select().from(mortgageSnapshot).where(eq(mortgageSnapshot.mortgageId, junk.id));
    expect(snaps).toHaveLength(0); // moved to the real record
    const events = await db.select().from(mortgageEvent).where(eq(mortgageEvent.mortgageId, real.id));
    expect(events.find((e) => e.kind === "merged")?.detail).toMatchObject({ fromAddress: "Sale Agreement - Financed", reason: "Pasted from the tablet heading by mistake" });
    const [audit] = await db.select().from(auditEvent).where(eq(auditEvent.action, "mortgages.merged"));
    expect(audit).toMatchObject({ targetId: junk.id, reason: "Pasted from the tablet heading by mistake" });
    expect(audit.metadata).toMatchObject({ intoId: real.id, snapshotsMoved: 1 });

    expect((await unconfirmedRecords()).some((r) => r.id === junk.id)).toBe(false);
    expect(await mortgageSyncPending()).toBe(false);
    await expect(mergeMortgage(fresh(ceo), { mortgageId: junk.id, intoId: real.id, reason: "Again please" })).rejects.toThrow(/not found/);
  });
});

describe("card-only loans", () => {
  /** An Active card for a borrower with no loan in the bank data. */
  const card = (stateId: number, principal: number) =>
    [
      "$2,600.00",
      "69811362",
      String(stateId),
      "TYPE loan",
      "State interest rate 1 %",
      "Broker interest rate 4 %",
      "Original total interest rate 5 %",
      "Current total interest rate 5% (0.00%)",
      "Missed payment amounts 0",
      "0/4complete",
      "Next payment: in 6 days",
      "every 7 days",
      "0/4 complete",
      `Loan Agreement Amount: $${principal}`,
    ].join("\n");

  it("are only added when someone chooses to, and only from a card that states the amount", async () => {
    const { cards } = await previewPaste(ceo, { tab: "active", text: card(77777, 10000) });
    expect(cards[0].match).toMatchObject({ kind: "new", principalCents: 1_000_000, refused: null, borrowerLoans: [] });
    await expect(commitPaste(ceo, { tab: "active", text: card(77777, 10000) })).rejects.toThrow(/Add as a new loan/);
    expect(await commitPaste(ceo, { tab: "active", text: card(77777, 10000), decisions: { "0": { loan: "new" } } })).toMatchObject({ created: 1 });
    // The same card twice in one paste is one card; a second, different loan for the same borrower is offered with context.
    const twice = `${card(77777, 10000)}\n${card(77777, 10000)}\n${card(77777, 25000)}`;
    const preview = await previewPaste(ceo, { tab: "active", text: twice });
    expect(preview.cards.map((c) => c.match.kind)).toEqual(["matched", "ignored", "new"]);
    expect(preview.cards[2].match).toMatchObject({ borrowerLoans: [expect.objectContaining({ principalCents: 1_000_000 })] });
    expect(await commitPaste(ceo, { tab: "active", text: twice, decisions: { "2": { loan: "new" } } })).toMatchObject({ created: 1 });

    // An Overdue card has no amount: it can't start a loan, whatever the browser sends.
    const overdue = card(88888, 5000).replace("Loan Agreement Amount: $5000", "OVERDUE: Missed payment 1/4 (1 missed)");
    const p2 = await previewPaste(ceo, { tab: "overdue", text: overdue });
    expect(p2.cards[0].match).toMatchObject({ kind: "new", refused: expect.stringMatching(/doesn’t state the loan amount/) });
    expect(await commitPaste(ceo, { tab: "overdue", text: overdue, decisions: { "0": { loan: "new" } } })).toMatchObject({ created: 0, skipped: 1 });
  });

  it("are flagged once the bank data has moved past them", async () => {
    await db.update(loan).set({ createdAt: new Date("2026-01-01T00:00:00Z") }).where(eq(loan.borrowerStateId, 77777));
    const flagged = (await unconfirmedRecords()).filter((r) => r.kind === "loan");
    expect(flagged.map((r) => r.principalCents).sort()).toEqual([1_000_000, 2_500_000]);
  });

  it("can be merged into the same borrower's other loan, or retired, by Management+ with a step-up", async () => {
    const loans = await db.select().from(loan).where(eq(loan.borrowerStateId, 77777));
    const small = loans.find((l) => l.principalCents === 1_000_000)!;
    const big = loans.find((l) => l.principalCents === 2_500_000)!;
    const [banked] = await db.select().from(loan).where(eq(loan.borrowerStateId, 8167));

    await expect(retireCardOnlyLoan(fresh(officer), { loanId: small.id, intoLoanId: null, reason: "Mistake" })).rejects.toThrow(/permission/);
    await expect(retireCardOnlyLoan(ceo, { loanId: small.id, intoLoanId: null, reason: "Mistake" })).rejects.toBeInstanceOf(StepUpRequiredError);
    await expect(retireCardOnlyLoan(fresh(ceo), { loanId: banked.id, intoLoanId: null, reason: "Mistake" })).rejects.toThrow(/bank disbursement/);
    await expect(retireCardOnlyLoan(fresh(ceo), { loanId: small.id, intoLoanId: banked.id, reason: "Mistake" })).rejects.toThrow(/same borrower/);
    // The database itself refuses to retire a loan that has its disbursement.
    await expect(db.update(loan).set({ retiredAt: new Date() }).where(eq(loan.id, banked.id))).rejects.toMatchObject({ cause: expect.objectContaining({ constraint: "loan_retired_card_only" }) });

    // Merge: the small loan's phone cards move to the big one; its own history stays with it.
    const smallCards = await db.select().from(loanCard).where(eq(loanCard.loanId, small.id));
    const bigCards = await db.select().from(loanCard).where(eq(loanCard.loanId, big.id));
    await retireCardOnlyLoan(fresh(ceo), { loanId: small.id, intoLoanId: big.id, reason: "Same loan pasted with a typo" });
    const [gone] = await db.select().from(loan).where(eq(loan.id, small.id));
    expect(gone).toMatchObject({ mergedIntoId: big.id, retiredAt: expect.any(Date) });
    expect(await getLoan(ceo, small.id)).toBeNull();
    expect(await mergedLoanInto(small.id)).toBe(big.id); // old links redirect
    expect((await listLoans(ceo, { status: "all", q: "77777" })).map((l) => l.id)).toEqual([big.id]);
    expect(await db.select().from(loanCard).where(eq(loanCard.loanId, big.id))).toHaveLength(bigCards.length + smallCards.length);
    expect((await db.select().from(loanEvent).where(eq(loanEvent.loanId, big.id))).some((e) => e.kind === "merged")).toBe(true);
    expect((await db.select().from(loanEvent).where(eq(loanEvent.loanId, small.id))).some((e) => e.kind === "merged_into")).toBe(true);
    const [merged] = await db.select().from(auditEvent).where(eq(auditEvent.action, "loans.card_only.merged"));
    expect(merged).toMatchObject({ targetId: small.id, reason: "Same loan pasted with a typo" });
    expect(merged.metadata).toMatchObject({ intoLoanId: big.id, principalCents: 1_000_000, cardsMoved: smallCards.length });
    await expect(retireCardOnlyLoan(fresh(ceo), { loanId: small.id, intoLoanId: null, reason: "Twice please" })).rejects.toThrow(/not found/);

    // Retire as a mistake: hidden everywhere, and its card is "new" again if pasted (never matched to it).
    await retireCardOnlyLoan(fresh(ceo), { loanId: big.id, intoLoanId: null, reason: "Never lent — test card" });
    expect(await listLoans(ceo, { status: "all", q: "77777" })).toEqual([]);
    expect(await getLoan(ceo, big.id)).toBeNull();
    expect(await mergedLoanInto(big.id)).toBeNull();
    const [retired] = await db.select().from(auditEvent).where(eq(auditEvent.action, "loans.card_only.retired"));
    expect(retired).toMatchObject({ targetId: big.id, reason: "Never lent — test card" });
    expect((await unconfirmedRecords()).some((r) => r.kind === "loan")).toBe(false);
    const again = await previewPaste(ceo, { tab: "active", text: card(77777, 25000) });
    expect(again.cards[0].match).toMatchObject({ kind: "new", borrowerLoans: [] });
  });
});
