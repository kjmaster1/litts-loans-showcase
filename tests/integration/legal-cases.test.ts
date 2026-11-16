import { readFileSync } from "node:fs";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/request", () => ({ getRequestMeta: async () => ({ ip: "203.0.113.10", userAgent: "vitest" }) }));

const { commitImport, stageImport } = await import("@/server/bank/import");
const { commitPaste } = await import("@/server/loans/paste");
const { addCollateral } = await import("@/server/loans/service");
const cases = await import("@/server/legal/cases");
const { sheetText } = await import("@/domain/legal/case-sheet");
const { db } = await import("@/server/db");
const { auditEvent, bankTransaction, importBatch, legalCaseHandover, legalFeeLink, loan, loanCard, loanCollectionAction, loanPaste, staff } = await import("@/server/db/schema");
const { syncLoans } = await import("@/server/loans/sync");
const { notificationsFor } = await import("@/server/notifications");
const { previewPaste } = await import("@/server/loans/paste");
const { assignOfficer } = await import("@/server/loans/service");
const { createOffer } = await import("@/server/origination/loan-offers");
const { resetDb } = await import("../support/db");

type Viewer = import("@/server/authz/viewer").Viewer;
const paste = (tab: string) => readFileSync(`tests/fixtures/paste-${tab}.txt`, "utf8");

let ceo: Viewer;
let manager: Viewer;
let officer: Viewer;
let otherOfficer: Viewer;
let lawyer: Viewer;
/** Two defaulted loans, both the officer's. */
let loanA: typeof loan.$inferSelect;
let loanB: typeof loan.$inferSelect;

async function makeViewer(stateId: number, name: string, role: Viewer["role"]): Promise<Viewer> {
  const [row] = await db.insert(staff).values({ stateId, characterName: name, role, status: "active" }).returning();
  return { staffId: row.id, userId: `u-${stateId}`, sessionId: `s-${stateId}`, role, characterName: name, stateId, username: name, twoFactorEnabled: true, stepUpAt: null, tourCompletedAt: null, tourRole: null };
}

beforeAll(async () => {
  await resetDb();
  ceo = await makeViewer(424242, "Legal Tester", "ceo");
  manager = await makeViewer(434343, "Legal Manager", "management");
  officer = await makeViewer(515151, "Officer One", "loan_officer");
  otherOfficer = await makeViewer(616161, "Officer Two", "loan_officer");
  lawyer = await makeViewer(717171, "Avery Counsel", "legal");
  const stagingId = await stageImport(ceo, { name: "export.xlsx", bytes: readFileSync("tests/fixtures/bank-export.xlsx") });
  await commitImport(ceo, stagingId);
  await commitPaste(ceo, { tab: "default", text: paste("default") });
  const defaulted = await db
    .select()
    .from(loan)
    .where(and(eq(loan.status, "defaulted"), sql`exists (select 1 from loan_card c where c.loan_id = ${loan.id})`))
    .orderBy(loan.openedAt)
    .limit(2);
  [loanA, loanB] = defaulted;
  await db.update(loan).set({ officerStaffId: officer.staffId }).where(inArray(loan.id, [loanA.id, loanB.id]));
});

const caseOf = async (v: Viewer, loanId: string) => (await cases.getCase(v, loanId))!;

describe("which loans have a case", () => {
  it("every defaulted or written-off loan, and a borrower's completed loan has no case", async () => {
    // Same borrower, a second loan that was paid off: never a case, never confused with the defaulted one.
    const [done] = await db
      .insert(loan)
      .values({ borrowerStateId: loanA.borrowerStateId, borrowerName: loanA.borrowerName, principalCents: 1_000_000, status: "completed", officerStaffId: officer.staffId })
      .returning();
    const list = await cases.listCases(ceo);
    const bad = await db.select({ id: loan.id }).from(loan).where(and(inArray(loan.status, ["defaulted", "written_off"]), sql`${loan.retiredAt} is null`));
    expect(list.map((c) => c.loanId).sort()).toEqual(bad.map((b) => b.id).sort());
    expect(list.filter((c) => c.stateId === loanA.borrowerStateId).map((c) => c.loanId)).not.toContain(done.id);
    expect(await cases.getCase(ceo, done.id)).toBeNull();
  });

  it("officers see only their own cases; Legal sees all", async () => {
    expect((await cases.listCases(otherOfficer)).length).toBe(0);
    expect((await cases.listCases(officer)).map((c) => c.loanId).sort()).toEqual([loanA.id, loanB.id].sort());
    expect((await cases.listCases(lawyer)).length).toBe((await cases.listCases(ceo)).length);
    expect(await cases.getCase(otherOfficer, loanA.id)).toBeNull();
  });
});

describe("contract details", () => {
  it("needs details until fee per day and collateral (or unsecured) are in", async () => {
    let c = await caseOf(ceo, loanA.id);
    expect(c.state).toBe("needs_details");
    expect(c.missing).toEqual(["fee_per_day", "collateral"]);
    expect(c.preview).toBeNull();
    expect(c.claimCents).toBeGreaterThan(0);

    await cases.setLegalTerms(officer, { loanId: loanA.id, feePerDayDollars: 200, unsecured: false });
    c = await caseOf(ceo, loanA.id);
    expect(c.missing).toEqual(["collateral"]);

    await addCollateral(officer, { loanId: loanA.id, description: "Ocelot Jackal - G1YBEU4B", estimatedValueCents: null });
    c = await caseOf(ceo, loanA.id);
    expect(c.state).toBe("ready");
    expect(sheetText(c.preview!)).toContain("$200 per day in default");
    expect(sheetText(c.preview!)).toContain("Collateral - Ocelot Jackal - G1YBEU4B");
    expect(await db.select().from(auditEvent).where(eq(auditEvent.action, "legal.terms_set"))).toHaveLength(1);
  });

  it("only the loan's officer or Legal and up can fill them in", async () => {
    await expect(cases.setLegalTerms(otherOfficer, { loanId: loanB.id, feePerDayDollars: 100, unsecured: true })).rejects.toThrow(/not found/i);
    await cases.setLegalTerms(lawyer, { loanId: loanB.id, feePerDayDollars: 100, unsecured: true });
    const c = await caseOf(ceo, loanB.id);
    expect(c.state).toBe("ready");
    expect(c.preview!.collateral).toBe("None (unsecured)");
  });

  it("Legal can ask the officer and record the contract as shared", async () => {
    await cases.requestDetails(lawyer, { loanId: loanB.id });
    await cases.markContractShared(officer, { loanId: loanB.id, shared: true });
    const c = await caseOf(ceo, loanB.id);
    expect(c.detailsRequestedAt).not.toBeNull();
    expect(c.contractSharedAt).not.toBeNull();
    await cases.markContractShared(officer, { loanId: loanB.id, shared: false });
    expect((await caseOf(ceo, loanB.id)).contractSharedAt).toBeNull();
  });

  it("a default date set by hand changes the preview", async () => {
    await expect(cases.setCaseDefaultDate(lawyer, { loanId: loanB.id, date: "2026-03-01", reason: "Moved by hand" })).rejects.toThrow(/permission/i);
    await cases.setCaseDefaultDate(officer, { loanId: loanB.id, date: "2026-03-01", reason: "Moved by hand" });
    expect((await caseOf(ceo, loanB.id)).preview!.defaultedOn).toBe("2026-03-01");
    await cases.setCaseDefaultDate(officer, { loanId: loanB.id, date: null, reason: "Back to the game's date" });
    expect((await caseOf(ceo, loanB.id)).preview!.defaultedOn).not.toBe("2026-03-01");
  });
});

describe("Hand to Legal", () => {
  const handedAt = new Date("2026-11-10T12:00:00Z");

  it("isn't for Legal, other officers, or a case that isn't ready", async () => {
    await expect(cases.handToLegal(lawyer, { loanId: loanA.id, payeeStaffId: lawyer.staffId }, handedAt)).rejects.toThrow(/permission/i);
    await expect(cases.handToLegal(otherOfficer, { loanId: loanA.id, payeeStaffId: lawyer.staffId }, handedAt)).rejects.toThrow(/not found/i);
    const [notReady] = (await cases.listCases(ceo)).filter((c) => c.state === "needs_details");
    await expect(cases.handToLegal(ceo, { loanId: notReady.loanId, payeeStaffId: lawyer.staffId }, handedAt)).rejects.toThrow(/fee per day|collateral|details/i);
  });

  it("the fee goes to a Legal Team member", async () => {
    await expect(cases.handToLegal(officer, { loanId: loanA.id, payeeStaffId: otherOfficer.staffId }, handedAt)).rejects.toThrow(/Legal Team/);
  });

  it("the loan's officer hands it over: frozen sheet, fee, collections entry", async () => {
    await cases.handToLegal(officer, { loanId: loanA.id, payeeStaffId: lawyer.staffId }, handedAt);
    const c = await caseOf(lawyer, loanA.id);
    expect(c.state).toBe("with_legal");
    expect(c.handover!.feeCents).toBe(275_000);
    expect(c.handover!.text).toBe(sheetText(c.handover!.sheet as never));
    expect(c.handover!.text).toContain("Collateral - Ocelot Jackal - G1YBEU4B");
    expect(c.payee).toMatchObject({ staffId: lawyer.staffId, stateId: 717171 });
    expect(c.feePaid).toBe(false);
    const [entry] = await db.select().from(loanCollectionAction).where(and(eq(loanCollectionAction.loanId, loanA.id), eq(loanCollectionAction.kind, "handed_to_legal")));
    expect(entry.note).toBe(`Case #LC${c.number} handed to Legal`);
  });

  it("is frozen against later cards", async () => {
    const before = (await caseOf(ceo, loanA.id)).handover!.text;
    const [p] = await db.insert(loanPaste).values({ tab: "default", cardCount: 1, matchedCount: 1, createdCount: 0, ignoredCount: 0 }).returning();
    const [last] = await db.select().from(loanCard).where(eq(loanCard.loanId, loanA.id)).orderBy(desc(loanCard.id)).limit(1);
    await db.insert(loanCard).values({ pasteId: p.id, loanId: loanA.id, position: 0, raw: last.raw, parsed: { ...(last.parsed as object), headerAmountCents: 9_999_900 } });
    const c = await caseOf(ceo, loanA.id);
    expect(c.handover!.text).toBe(before);
    expect(c.state).toBe("with_legal");
    // The list and the case's claim use the frozen figures too, not the new card.
    const frozenTotal = (c.handover!.sheet as { totalCents: number }).totalCents;
    expect((await cases.listCases(ceo)).find((r) => r.loanId === loanA.id)!.totalCents).toBe(frozenTotal);
    expect(c.stillOwedCents).toBe(frozenTotal - c.recoveredSinceHandoverCents);
  });

  it("handing over again needs management and a reason", async () => {
    await expect(cases.handToLegal(officer, { loanId: loanA.id, payeeStaffId: lawyer.staffId }, handedAt)).rejects.toThrow(/already/i);
    await expect(cases.handToLegal(manager, { loanId: loanA.id, payeeStaffId: lawyer.staffId }, handedAt)).rejects.toThrow(/reason/i);
    await cases.handToLegal(manager, { loanId: loanA.id, payeeStaffId: lawyer.staffId, reason: "Wrong fee per day" }, new Date("2026-11-11T12:00:00Z"));
    const c = await caseOf(ceo, loanA.id);
    expect(c.earlierHandovers).toBe(1);
    expect(c.handover!.reason).toBe("Wrong fee per day");
    expect(await db.select().from(legalCaseHandover)).toHaveLength(2);
  });

  it("closing needs management and a note", async () => {
    await expect(cases.closeCase(officer, { loanId: loanA.id, note: "Collateral sold" })).rejects.toThrow(/permission/i);
    await cases.closeCase(manager, { loanId: loanA.id, note: "Collateral sold, rest unrecoverable" });
    expect((await caseOf(ceo, loanA.id)).state).toBe("closed");
    expect((await cases.listCases(ceo)).find((r) => r.loanId === loanA.id)!.state).toBe("closed");
  });
});

describe("attorney & filing fee payments", () => {
  let n = 0;

  /** A `pay` row from the business wallet to the lawyer, as the bank export brings it. */
  async function payRow(comment: string, at = new Date("2026-11-10T14:00:00Z")) {
    const [batch] = await db.select({ id: importBatch.id }).from(importBatch).limit(1);
    const [row] = await db
      .insert(bankTransaction)
      .values({
        batchId: batch.id,
        walletId: "69811362",
        occurredAt: at,
        direction: "out",
        txType: "pay",
        amountCents: 275_000,
        sourceWallet: "69811362",
        targetWallet: "69683223",
        initiatorName: "Legal Tester",
        initiatorStateId: 424242,
        comment,
        fingerprint: `legal-fee-test-${++n}`,
        occurrence: 0,
        category: "legal",
        confidence: "heuristic",
        rulesetVersion: 1,
      })
      .returning({ id: bankTransaction.id });
    return row.id;
  }

  it("a referenced fee payment links on the next sync", async () => {
    const c = await caseOf(ceo, loanA.id);
    const tx = await payRow(`Employee Pay: Attorney & Filing Fee - ${c.borrowerName} Default #LC${c.number}`);
    await syncLoans();
    const after = await caseOf(ceo, loanA.id);
    expect(after.feePaid).toBe(true);
    expect(after.feePayments.map((f) => f.txId)).toEqual([tx]);
    expect(after.feePaidCents).toBe(275_000);
    const [link] = await db.select().from(legalFeeLink).where(eq(legalFeeLink.bankTransactionId, tx));
    expect(link).toMatchObject({ action: "link", method: "reference" });
  });

  it("learns the lawyer's wallet from the first fee payment linked by reference", async () => {
    // No staff page field holds it; the payment the helper made says where the lawyer's money goes.
    const [s] = await db.select({ walletId: staff.walletId }).from(staff).where(eq(staff.id, lawyer.staffId));
    expect(s.walletId).toBe("69683223");
    const [learned] = await db.select().from(auditEvent).where(eq(auditEvent.action, "legal.lawyer_wallet_learned"));
    expect(learned.metadata).toMatchObject({ staffId: lawyer.staffId, walletId: "69683223" });
  });

  it("re-running the sync adds nothing", async () => {
    const before = (await db.select().from(legalFeeLink)).length;
    await syncLoans();
    expect((await db.select().from(legalFeeLink)).length).toBe(before);
  });

  it("a reference to a case that wasn't handed over is ignored", async () => {
    const b = await caseOf(ceo, loanB.id);
    expect(b.number).not.toBeNull();
    const tx = await payRow(`Employee Pay: Attorney & Filing Fee - ${b.borrowerName} Default #LC${b.number}`);
    await syncLoans();
    expect(await db.select().from(legalFeeLink).where(eq(legalFeeLink.bankTransactionId, tx))).toHaveLength(0);
  });

  it("an unreferenced fee payment is only suggested, and a person confirms it", async () => {
    // loanB handed over first, so a hand-typed payment after it can be suggested.
    await cases.setCaseDefaultDate(officer, { loanId: loanB.id, date: null, reason: "Back to the game's date" });
    await cases.handToLegal(officer, { loanId: loanB.id, payeeStaffId: lawyer.staffId }, new Date("2026-11-12T10:00:00Z"));
    const b = await caseOf(ceo, loanB.id);
    const tx = await payRow(`Employee Pay: Attorney & Filing Fee - ${b.borrowerName} Default`, new Date("2026-11-12T11:00:00Z"));
    await syncLoans();
    let c = await caseOf(ceo, loanB.id);
    // The #LC payment from the test above was ignored while the case wasn't with Legal; now it links.
    expect(c.feePayments).toHaveLength(1);
    expect(c.feeSuggestions.map((f) => f.txId)).toEqual([tx]);

    await expect(cases.confirmFeePayment(otherOfficer, { loanId: loanB.id, txId: tx })).rejects.toThrow(/not found/i);
    await cases.confirmFeePayment(officer, { loanId: loanB.id, txId: tx });
    c = await caseOf(ceo, loanB.id);
    expect(c.feePayments.map((f) => f.txId)).toContain(tx);
    expect(c.feeSuggestions).toEqual([]);
    const [link] = await db.select().from(legalFeeLink).where(eq(legalFeeLink.bankTransactionId, tx));
    expect(link).toMatchObject({ action: "link", method: "confirmed", staffId: officer.staffId });
    await expect(cases.confirmFeePayment(officer, { loanId: loanB.id, txId: tx })).rejects.toThrow(/already/i);
  });

  it("an automatic link needs the borrower's name: a mistyped reference is only suggested (review I2)", async () => {
    const a = await caseOf(ceo, loanA.id);
    const b = await caseOf(ceo, loanB.id);
    // B's fee, but with A's case number typed by mistake.
    const tx = await payRow(`Employee Pay: Attorney & Filing Fee - ${b.borrowerName} Default #LC${a.number}`, new Date("2026-11-13T09:00:00Z"));
    await syncLoans();
    expect((await caseOf(ceo, loanA.id)).feePayments.map((f) => f.txId)).not.toContain(tx);
    expect((await caseOf(ceo, loanB.id)).feeSuggestions.map((f) => f.txId)).toContain(tx);
  });

  it("management can undo a wrong link, with a reason; nothing links it back by itself (review I2)", async () => {
    const before = await caseOf(ceo, loanB.id);
    const wrong = before.feePayments.at(-1)!.txId;
    await expect(cases.unlinkFeePayment(officer, { loanId: loanB.id, txId: wrong, reason: "Not this case" })).rejects.toThrow(/permission/i);
    await expect(cases.unlinkFeePayment(manager, { loanId: loanB.id, txId: wrong, reason: "" })).rejects.toThrow();
    await cases.unlinkFeePayment(manager, { loanId: loanB.id, txId: wrong, reason: "Paid for another case" });
    await syncLoans();
    const after = await caseOf(ceo, loanB.id);
    expect(after.feePayments.map((f) => f.txId)).not.toContain(wrong);
    expect(after.feeSuggestions.map((f) => f.txId)).not.toContain(wrong);
    expect(await db.select().from(auditEvent).where(eq(auditEvent.action, "legal.fee_unlinked"))).toHaveLength(1);
    // It can be linked again by a person.
    await cases.confirmFeePayment(manager, { loanId: loanB.id, txId: wrong });
    expect((await caseOf(ceo, loanB.id)).feePayments.map((f) => f.txId)).toContain(wrong);
  });

  it("a linked fee payment can't be reclassified (review I2)", async () => {
    const { reclassifyTransaction } = await import("@/server/bank/reclassify");
    const tx = (await caseOf(ceo, loanA.id)).feePayments[0].txId;
    await expect(reclassifyTransaction({ ...ceo, stepUpAt: new Date().toISOString() }, { transactionId: tx, category: "other_expense", reason: "test" })).rejects.toThrow(/legal case/);
  });
});

describe("bell", () => {
  let loanC: typeof loan.$inferSelect;
  const handedAt = new Date("2026-11-13T09:00:00Z");

  beforeAll(async () => {
    [loanC] = await db
      .select()
      .from(loan)
      .where(and(eq(loan.status, "defaulted"), sql`${loan.id} not in (${loanA.id}, ${loanB.id})`, sql`exists (select 1 from loan_card c where c.loan_id = ${loan.id})`))
      .limit(1);
    await db.update(loan).set({ officerStaffId: officer.staffId }).where(eq(loan.id, loanC.id));
  });

  const legalKinds = async (v: Viewer, now?: Date) => (await notificationsFor(v, now)).filter((n) => n.kind.startsWith("legal_") && n.href === `/loans/legal/${loanC.id}`);

  it("tells the officer Legal needs the contract details, until they're in", async () => {
    expect(await legalKinds(officer)).toEqual([]);
    await cases.requestDetails(lawyer, { loanId: loanC.id });
    const [n] = await legalKinds(officer);
    expect(n).toMatchObject({ kind: "legal_details_requested", title: `Legal needs the contract details for ${loanC.borrowerName}` });
    expect(await legalKinds(otherOfficer)).toEqual([]);
    expect(await legalKinds(ceo)).toEqual([]);
    await cases.setLegalTerms(officer, { loanId: loanC.id, feePerDayDollars: 150, unsecured: true });
    expect(await legalKinds(officer)).toEqual([]);
  });

  it("reminds whoever handed it over, and the executives, when the fee isn't paid a day later", async () => {
    await cases.handToLegal(officer, { loanId: loanC.id, payeeStaffId: lawyer.staffId }, handedAt);
    const soon = new Date(handedAt.getTime() + 23 * 3_600_000);
    const later = new Date(handedAt.getTime() + 25 * 3_600_000);
    expect(await legalKinds(officer, soon)).toEqual([]);
    expect((await legalKinds(officer, later)).map((n) => n.kind)).toEqual(["legal_fee_unpaid"]);
    expect((await legalKinds(ceo, later)).map((n) => n.title)).toEqual([`Attorney & filing fee not paid: ${loanC.borrowerName}`]);
    expect(await legalKinds(manager, later)).toEqual([]);
    expect(await legalKinds(lawyer, later)).toEqual([]);

    const c = await caseOf(ceo, loanC.id);
    // The fee is a cost once handed over, before it's paid (review: "recovered − fee").
    expect(c.netForLittsCents).toBe(c.recoveredSinceHandoverCents - 275_000);
    const [batch] = await db.select({ id: importBatch.id }).from(importBatch).limit(1);
    await db.insert(bankTransaction).values({
      batchId: batch.id, walletId: "69811362", occurredAt: later, direction: "out", txType: "pay", amountCents: 275_000, comment: `Employee Pay: Attorney & Filing Fee - ${c.borrowerName} Default #LC${c.number}`,
      fingerprint: "legal-fee-bell", occurrence: 0, category: "legal", confidence: "heuristic", rulesetVersion: 1,
    });
    await syncLoans();
    expect(await legalKinds(ceo, later)).toEqual([]);
  });
});

describe("the lawyer's login", () => {
  it("is not a loan officer option", async () => {
    const { activeStaffOptions } = await import("@/server/loans/queries");
    expect((await activeStaffOptions()).map((s) => s.id)).not.toContain(lawyer.staffId);
    expect((await activeStaffOptions({ finished: true })).map((s) => s.id)).not.toContain(lawyer.staffId);
    expect((await activeStaffOptions()).map((s) => s.id)).toContain(officer.staffId);
  });

  it("is never suggested for the commission pool, though it used the app this week", async () => {
    const { getWeek } = await import("@/server/commissions/service");
    const now = new Date();
    const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ((now.getUTCDay() + 6) % 7)));
    const w = await getWeek(monday.toISOString().slice(0, 10), now);
    const entry = w.roster.find((r) => r.staffId === lawyer.staffId)!;
    expect(entry.evidence.appActions).toBeGreaterThan(0);
    expect(entry).toMatchObject({ suggested: false, included: false });
  });
});

describe("the lawyer can't become an officer by any route (review C1)", () => {
  let unassigned: typeof loan.$inferSelect;
  beforeAll(async () => {
    [unassigned] = await db.select().from(loan).where(and(sql`${loan.officerStaffId} is null`, sql`${loan.retiredAt} is null`)).limit(1);
  });

  it("not offered on the paste screen, and can't claim pasted loans", async () => {
    const asCeo = await previewPaste(ceo, { tab: "default", text: paste("default") });
    expect(asCeo.officers.map((o) => o.id)).not.toContain(lawyer.staffId);
    expect((await previewPaste(lawyer, { tab: "default", text: paste("default") })).officers).toEqual([]);
  });

  it("refused when pasted with them as officer", async () => {
    await expect(commitPaste(ceo, { tab: "default", text: paste("default"), decisions: { "0": { officerStaffId: lawyer.staffId } } })).rejects.toThrow(/Legal Team/);
  });

  it("refused by Change officer, and a lawyer can't claim a loan", async () => {
    await expect(assignOfficer(ceo, { loanId: unassigned.id, officerStaffId: lawyer.staffId })).rejects.toThrow(/Legal Team/);
    await expect(assignOfficer(lawyer, { loanId: unassigned.id, officerStaffId: lawyer.staffId })).rejects.toThrow(/claim/);
  });

  it("can't make a loan offer as its officer", async () => {
    const offer = { kind: "general" as const, borrowerStateId: 40001, borrowerName: "Avery Lane", amountDollars: 20_000, ratePct: 15, stateRatePct: 1, weeks: 6, startsOn: new Date().toISOString().slice(0, 10), collateral: "", defaultFeePerDayDollars: 100 };
    await expect(createOffer(lawyer, offer)).rejects.toThrow(/Legal Team/);
    await expect(createOffer(ceo, { ...offer, officerStaffId: lawyer.staffId })).rejects.toThrow(/Legal Team/);
  });
});

describe("default date rule (review I1)", () => {
  it("a loan moved to Default by hand counts from its second missed payment, and says so", async () => {
    const rows = await cases.listCases(ceo);
    const handMoved = rows.filter((r) => r.defaultRule === "hand_moved");
    expect(handMoved.length).toBeGreaterThan(0);
    for (const r of handMoved) {
      const [card] = await db.execute<{ first: string; period: number | null }>(sql`
        select c.parsed->>'firstMissedAt' as first, l.period_days as period from loan_card c join loan_paste p on p.id = c.paste_id join loan l on l.id = c.loan_id
         where c.loan_id = ${r.loanId} order by p.captured_at desc, c.id desc limit 1`).then((x) => x.rows);
      expect(r.defaultAt!.getTime()).toBe(new Date(card.first).getTime() + (card.period ?? 7) * 86_400_000);
    }
  });

  it("without a first missed date it needs the date set by hand before it's ready", async () => {
    const [x] = (await cases.listCases(ceo)).filter((r) => r.state !== "with_legal" && r.state !== "closed");
    const [last] = await db.select().from(loanCard).where(eq(loanCard.loanId, x.loanId)).orderBy(desc(loanCard.id)).limit(1);
    const [p] = await db.insert(loanPaste).values({ tab: "default", cardCount: 1, matchedCount: 1, createdCount: 0, ignoredCount: 0 }).returning();
    await db.insert(loanCard).values({ pasteId: p.id, loanId: x.loanId, position: 0, raw: last.raw, parsed: { ...(last.parsed as object), missedPayments: 2, firstMissedAt: null } });
    let c = await caseOf(ceo, x.loanId);
    expect(c.defaultRule).toBe("unconfirmed");
    expect(c.missing).toContain("default_date");
    await cases.setCaseDefaultDate(ceo, { loanId: x.loanId, date: "2026-10-06", reason: "Moved by hand after the 2nd miss" });
    c = await caseOf(ceo, x.loanId);
    expect(c.defaultRule).toBe("override");
    expect(c.missing).not.toContain("default_date");
  });
});

describe("smaller fixes (2026-11-10 follow-up)", () => {
  /** A defaulted loan with a phone card and no legal case yet, made the officer's. */
  async function freshLoan(officerId = officer.staffId) {
    const [l] = await db
      .select()
      .from(loan)
      .where(
        and(
          eq(loan.status, "defaulted"),
          sql`${loan.retiredAt} is null`,
          sql`exists (select 1 from loan_card c where c.loan_id = ${loan.id})`,
          sql`not exists (select 1 from legal_case lc where lc.loan_id = ${loan.id})`,
          sql`${loan.defaultFeePerDayCents} is null and not ${loan.unsecured}`,
          sql`not exists (select 1 from loan_collateral k where k.loan_id = ${loan.id})`,
        ),
      )
      .limit(1);
    await db.update(loan).set({ officerStaffId: officerId }).where(eq(loan.id, l.id));
    return l;
  }
  const handovers = async (loanId: string) =>
    (await db.execute<{ n: number }>(sql`select count(*)::int as n from legal_case_handover h join legal_case c on c.id = h.case_id where c.loan_id = ${loanId}`)).rows[0].n;
  let unpaid: typeof loan.$inferSelect;

  it("two people pressing Hand to Legal together make one hand-over", async () => {
    const l = await freshLoan();
    await cases.setLegalTerms(officer, { loanId: l.id, feePerDayDollars: 100, unsecured: true });
    const results = await Promise.allSettled([
      cases.handToLegal(officer, { loanId: l.id, payeeStaffId: lawyer.staffId }),
      cases.handToLegal(ceo, { loanId: l.id, payeeStaffId: lawyer.staffId }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await handovers(l.id)).toBe(1);
    unpaid = l;
  });

  it("today's date can be set as the default date in the morning", async () => {
    const l = await freshLoan();
    await cases.setCaseDefaultDate(officer, { loanId: l.id, date: "2026-11-10", reason: "Defaulted today" }, new Date("2026-11-10T08:00:00Z"));
    await expect(cases.setCaseDefaultDate(officer, { loanId: l.id, date: "2026-11-11", reason: "Tomorrow" }, new Date("2026-11-10T08:00:00Z"))).rejects.toThrow(/future/);
  });

  it("case numbers don't skip", async () => {
    const first = await freshLoan();
    await cases.requestDetails(lawyer, { loanId: first.id });
    await cases.requestDetails(lawyer, { loanId: first.id });
    await cases.markContractShared(officer, { loanId: first.id, shared: true });
    const second = await freshLoan();
    await cases.requestDetails(lawyer, { loanId: second.id });
    expect((await caseOf(ceo, second.id)).number).toBe((await caseOf(ceo, first.id)).number! + 1);
  });

  it("after the hand-over only management changes the contract details; nobody on a closed case", async () => {
    await expect(cases.setLegalTerms(officer, { loanId: loanB.id, feePerDayDollars: 300, unsecured: true })).rejects.toThrow(/with Legal/);
    await expect(cases.setLegalTerms(lawyer, { loanId: loanB.id, feePerDayDollars: 300, unsecured: true })).rejects.toThrow(/with Legal/);
    await cases.setLegalTerms(manager, { loanId: loanB.id, feePerDayDollars: 100, unsecured: true });
    await expect(cases.setLegalTerms(manager, { loanId: loanA.id, feePerDayDollars: 300, unsecured: false })).rejects.toThrow(/closed/);
  });

  it("an unnamed fee payment of the right amount to the lawyer is suggested", async () => {
    await db.update(staff).set({ walletId: "69683223" }).where(eq(staff.id, lawyer.staffId));
    const [batch] = await db.select({ id: importBatch.id }).from(importBatch).limit(1);
    const row = async (comment: string, amountCents: number, fingerprint: string) =>
      (
        await db
          .insert(bankTransaction)
          .values({ batchId: batch.id, walletId: "69811362", occurredAt: new Date(), direction: "out", txType: "pay", amountCents, targetWallet: "69683223", comment, fingerprint, occurrence: 0, category: "legal", confidence: "heuristic", rulesetVersion: 1 })
          .returning({ id: bankTransaction.id })
      )[0].id;
    const plain = await row("Employee Pay: Attorney & Filing Fee", 275_000, "fee-plain");
    const wrongAmount = await row("Employee Pay: Attorney & Filing Fee", 100_000, "fee-amount");
    const b = await caseOf(ceo, loanB.id);
    const otherName = await row(`Employee Pay: Attorney & Filing Fee - ${b.borrowerName} Default`, 275_000, "fee-other");
    const ids = (await caseOf(ceo, unpaid.id)).feeSuggestions.map((f) => f.txId);
    expect(ids).toContain(plain);
    expect(ids).not.toContain(wrongAmount);
    expect(ids).not.toContain(otherName);
  });

  it("the unpaid-fee reminder stops when the loan leaves Default", async () => {
    const later = new Date(Date.now() + 25 * 3_600_000);
    // Whoever won the hand-over above, the executives are reminded.
    const mine = async () => (await notificationsFor(ceo, later)).filter((n) => n.kind === "legal_fee_unpaid" && n.href === `/loans/legal/${unpaid.id}`);
    expect(await mine()).toHaveLength(1);
    await db.update(loan).set({ status: "completed" }).where(eq(loan.id, unpaid.id));
    expect(await mine()).toEqual([]);
    await db.update(loan).set({ status: "defaulted" }).where(eq(loan.id, unpaid.id));
  });

  it("asking an officer who has left is refused, and the case says so", async () => {
    const l = await freshLoan(otherOfficer.staffId);
    await db.update(staff).set({ status: "departed" }).where(eq(staff.id, otherOfficer.staffId));
    try {
      await expect(cases.requestDetails(lawyer, { loanId: l.id })).rejects.toThrow(/no longer/);
      expect((await caseOf(ceo, l.id)).officerWorking).toBe(false);
    } finally {
      await db.update(staff).set({ status: "active" }).where(eq(staff.id, otherOfficer.staffId));
    }
  });

  it("Unsecured with collateral recorded isn't ready: one of them is wrong", async () => {
    const l = await freshLoan();
    await cases.setLegalTerms(officer, { loanId: l.id, feePerDayDollars: 100, unsecured: true });
    expect((await caseOf(ceo, l.id)).state).toBe("ready");
    await addCollateral(officer, { loanId: l.id, description: "Pegassi Zentorno - ZEN0001", estimatedValueCents: null });
    const c = await caseOf(ceo, l.id);
    expect(c.missing).toEqual(["collateral_conflict"]);
    expect(c.state).toBe("needs_details");
  });

  it("the fee per day and the collateral are saved together, or not at all", async () => {
    const l = await freshLoan();
    await expect(cases.setLegalTerms(officer, { loanId: l.id, feePerDayDollars: 150, unsecured: false, collateral: "x" })).rejects.toThrow();
    expect((await caseOf(ceo, l.id)).feePerDayCents).toBeNull();
    await cases.setLegalTerms(officer, { loanId: l.id, feePerDayDollars: 150, unsecured: false, collateral: "Pegassi Zentorno - ZEN0002" });
    const c = await caseOf(ceo, l.id);
    expect(c.state).toBe("ready");
    expect(c.collateral).toBe("Pegassi Zentorno - ZEN0002");
  });

  it("never gives the lawyer a wallet that's already someone else's", async () => {
    const [second] = await db.insert(staff).values({ stateId: 727272, characterName: "Second Counsel", role: "legal", status: "active" }).returning();
    await db.update(staff).set({ walletId: "69000001" }).where(eq(staff.id, otherOfficer.staffId));
    const l = await freshLoan();
    await cases.setLegalTerms(officer, { loanId: l.id, feePerDayDollars: 100, unsecured: true });
    await cases.handToLegal(officer, { loanId: l.id, payeeStaffId: second.id });
    const c = await caseOf(ceo, l.id);
    const [batch] = await db.select({ id: importBatch.id }).from(importBatch).limit(1);
    await db.insert(bankTransaction).values({
      batchId: batch.id, walletId: "69811362", occurredAt: new Date(), direction: "out", txType: "pay", amountCents: 275_000, targetWallet: "69000001",
      comment: `Employee Pay: [LEGAL] Attorney & Filing Fee - ${c.borrowerName} Default #LC${c.number}`, fingerprint: "fee-taken-wallet", occurrence: 0, category: "legal", confidence: "tag", rulesetVersion: 1,
    });
    await syncLoans();
    expect((await caseOf(ceo, l.id)).feePaid).toBe(true);
    const [after] = await db.select({ walletId: staff.walletId }).from(staff).where(eq(staff.id, second.id));
    expect(after.walletId).toBeNull();
  });

  it("hand-over refuses a total that changed since the page was loaded", async () => {
    const l = await freshLoan();
    await cases.setLegalTerms(officer, { loanId: l.id, feePerDayDollars: 100, unsecured: true });
    const ready = await caseOf(ceo, l.id);
    expect(ready.missing).toEqual([]);
    const shown = ready.preview!.totalCents;
    await expect(cases.handToLegal(officer, { loanId: l.id, payeeStaffId: lawyer.staffId, expectedTotalCents: shown - 10_000 })).rejects.toThrow(/changed/);
    await cases.handToLegal(officer, { loanId: l.id, payeeStaffId: lawyer.staffId, expectedTotalCents: shown });
    expect(await handovers(l.id)).toBe(1);
  });
});

describe("a note for Legal when the officer's contract differs from the game (owner, 2026-11-10)", () => {
  let l: typeof loan.$inferSelect;
  beforeAll(async () => {
    [l] = await db
      .select()
      .from(loan)
      .where(
        and(
          eq(loan.status, "defaulted"),
          sql`${loan.retiredAt} is null`,
          sql`exists (select 1 from loan_card c where c.loan_id = ${loan.id})`,
          sql`not exists (select 1 from legal_case lc where lc.loan_id = ${loan.id})`,
          sql`not exists (select 1 from loan_collateral k where k.loan_id = ${loan.id})`,
        ),
      )
      .limit(1);
    await db.update(loan).set({ officerStaffId: officer.staffId }).where(eq(loan.id, l.id));
    await cases.setLegalTerms(officer, { loanId: l.id, feePerDayDollars: 250, unsecured: true });
  });

  it("is management's: not the officer's or Legal's", async () => {
    await expect(cases.setContractNote(officer, { loanId: l.id, dollars: 5161, reason: "Contract written at 22%" })).rejects.toThrow(/permission/i);
    await expect(cases.setContractNote(lawyer, { loanId: l.id, dollars: 5161, reason: "Contract written at 22%" })).rejects.toThrow(/permission/i);
    await expect(cases.setContractNote(manager, { loanId: l.id, dollars: 5161, reason: "" })).rejects.toThrow(/why/);
  });

  it("is shown on the case, the sheet still claims the phone card's amount, and it's audited", async () => {
    const before = await caseOf(ceo, l.id);
    await cases.setContractNote(manager, { loanId: l.id, dollars: 5161, reason: "Contract written at 22%" });
    const after = await caseOf(ceo, l.id);
    expect(after.contractNote).toMatchObject({ cents: 516_100, reason: "Contract written at 22%", byName: "Legal Manager" });
    expect(after.preview!.instalmentCents).toBe(before.cardInstalmentCents);
    expect(after.preview!.instalmentCents).toBe(before.preview!.instalmentCents);
    expect(after.claimCents).toBe(before.claimCents);
    expect((await caseOf(lawyer, l.id)).contractNote?.cents).toBe(516_100);
    const [a] = await db.select().from(auditEvent).where(and(eq(auditEvent.action, "legal.contract_note_set"), eq(auditEvent.targetId, l.id)));
    expect(a.metadata).toMatchObject({ fromCents: null, toCents: 516_100, reason: "Contract written at 22%" });
  });

  it("the same amount again is refused; it can be removed", async () => {
    await expect(cases.setContractNote(manager, { loanId: l.id, dollars: 5161, reason: "Again" })).rejects.toThrow(/already/);
    await cases.setContractNote(ceo, { loanId: l.id, dollars: null, reason: "Paper matches the game after all" });
    expect((await caseOf(ceo, l.id)).contractNote).toBeNull();
    await expect(cases.setContractNote(ceo, { loanId: l.id, dollars: null, reason: "Again" })).rejects.toThrow(/no contract note/);
  });

  it("can be added after the hand-over without changing the frozen sheet; not on a closed case", async () => {
    await cases.handToLegal(officer, { loanId: l.id, payeeStaffId: lawyer.staffId });
    const frozen = (await caseOf(ceo, l.id)).handover!.text;
    await cases.setContractNote(manager, { loanId: l.id, dollars: 9999, reason: "Contract says $9,999" });
    const c = await caseOf(ceo, l.id);
    expect(c.handover!.text).toBe(frozen);
    expect(c.contractNote?.cents).toBe(999_900);
    await cases.closeCase(manager, { loanId: l.id, note: "Settled" });
    await expect(cases.setContractNote(manager, { loanId: l.id, dollars: 5000, reason: "Too late" })).rejects.toThrow(/closed/);
  });
});
