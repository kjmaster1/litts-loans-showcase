import { readFileSync } from "node:fs";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/request", () => ({ getRequestMeta: async () => ({ ip: "203.0.113.10", userAgent: "vitest" }) }));

const { commitImport, cashBalanceCents, stageImport } = await import("@/server/bank/import");
const { trialBalance } = await import("@/server/ledger/queries");
const { syncLoans } = await import("@/server/loans/sync");
const { commitPaste, previewPaste } = await import("@/server/loans/paste");
const { assignOfficer, writeOffLoan } = await import("@/server/loans/service");
const { borrowerSummary, getLoan, listLoans, loanKpis } = await import("@/server/loans/queries");
const { StepUpRequiredError } = await import("@/server/auth/step-up");
const { db } = await import("@/server/db");
const { auditEvent, journalEntry, journalLine, loan, loanCard, loanEvent, loanPaymentLink, staff } = await import("@/server/db/schema");
const { resetDb } = await import("../support/db");

type Viewer = import("@/server/authz/viewer").Viewer;
const REPORTED = 18_533_100;
const paste = (tab: string) => readFileSync(`tests/fixtures/paste-${tab}.txt`, "utf8");

let ceo: Viewer;
let officer: Viewer;
let otherOfficer: Viewer;

async function makeViewer(stateId: number, name: string, role: Viewer["role"]): Promise<Viewer> {
  const [row] = await db.insert(staff).values({ stateId, characterName: name, role, status: "active" }).returning();
  return { staffId: row.id, userId: `u-${stateId}`, sessionId: `s-${stateId}`, role, characterName: name, stateId, username: name, twoFactorEnabled: true, stepUpAt: null, tourCompletedAt: null, tourRole: null };
}

async function balanced() {
  const tb = await trialBalance();
  return tb.reduce((s, r) => s + r.debitCents, 0) === tb.reduce((s, r) => s + r.creditCents, 0);
}

const receivable = async () => (await trialBalance()).find((a) => a.code === "1100")!.balanceCents;

beforeAll(async () => {
  await resetDb();
  ceo = await makeViewer(424242, "Loan Tester", "ceo");
  officer = await makeViewer(515151, "Officer One", "loan_officer");
  otherOfficer = await makeViewer(616161, "Officer Two", "loan_officer");
  const stagingId = await stageImport(ceo, { name: "export.xlsx", bytes: readFileSync("tests/fixtures/bank-export.xlsx") });
  await commitImport(ceo, stagingId);
});

describe("loan sync after a bank import", () => {
  it("creates a loan for every disbursement and links its payments", async () => {
    const [{ n: loans }] = await db.select({ n: count() }).from(loan);
    expect(loans).toBe(85);
    const [{ n: links }] = await db.select({ n: count() }).from(loanPaymentLink);
    expect(links).toBeGreaterThan(85 + 560);
    // Terms are unknown until a card is pasted, so no levy has been posted yet.
    const [{ n: levied }] = await db.select({ n: count() }).from(loanPaymentLink).where(sql`${loanPaymentLink.levyEntryId} is not null`);
    expect(levied).toBe(0);
    expect(await cashBalanceCents()).toBe(REPORTED);
  });

  it("is idempotent", async () => {
    expect(await syncLoans()).toEqual({ loansCreated: 0, linksCreated: 0, levyEntries: 0, levyCorrections: 0, penaltyEntries: 0, recoveryEntries: 0, closingEntries: 0 });
  });

  it("records what it did in the import's audit entry", async () => {
    const [event] = await db.select().from(auditEvent).where(eq(auditEvent.action, "bank.import.committed"));
    expect(event.metadata).toMatchObject({ loans: { loansCreated: 85 } });
  });
});

describe("weekly card paste", () => {
  it("previews without changing anything", async () => {
    const preview = await previewPaste(ceo, { tab: "active", text: paste("active") });
    expect(preview.counts.ambiguous).toBe(0);
    expect(preview.counts.new).toBe(0);
    expect(preview.counts.matched).toBeGreaterThan(0);
    expect(preview.cards.every((c) => c.match.kind === "matched" || c.match.kind === "ignored")).toBe(true);
    const [{ n }] = await db.select({ n: count() }).from(loanCard);
    expect(n).toBe(0);
  });

  it("refuses text with no cards", async () => {
    await expect(previewPaste(ceo, { tab: "active", text: "hello" })).rejects.toThrow(/No loan cards/);
  });

  it("sets terms and status from all four tabs and posts the State levy", async () => {
    const before = await receivable();
    for (const tab of ["active", "overdue", "default", "complete"] as const) {
      const result = await commitPaste(ceo, { tab, text: paste(tab) });
      expect(result.created).toBe(0);
    }
    const statuses = await db.select({ status: loan.status, n: count() }).from(loan).groupBy(loan.status);
    const by = Object.fromEntries(statuses.map((s) => [s.status, s.n]));
    expect(by.completed).toBeGreaterThan(40);
    expect((by.active ?? 0) + (by.overdue ?? 0)).toBeGreaterThan(0);
    expect(by.defaulted).toBeGreaterThan(0);
    // Status is the tab: Active-tab cards showing a missed payment stay active.
    expect(by.overdue).toBe(1);

    const [{ n: unknownTerms }] = await db.select({ n: count() }).from(loan).where(sql`${loan.instalments} is null`);
    expect(unknownTerms).toBe(0);

    const [{ n: levied }] = await db.select({ n: count() }).from(loanPaymentLink).where(sql`${loanPaymentLink.levyEntryId} is not null`);
    expect(levied).toBeGreaterThan(300);
    expect(await receivable()).toBeLessThan(before);
    expect(await cashBalanceCents()).toBe(REPORTED); // the levy is non-cash
    expect(await balanced()).toBe(true);
  });

  it("closes completed loans' receivable to zero with a closing adjustment", async () => {
    const rows = await listLoans(ceo, { status: "completed" });
    expect(rows.length).toBeGreaterThan(40);
    expect(rows.filter((r) => r.outstandingCents !== 0)).toEqual([]);
    const tb = await trialBalance();
    const shortfall = tb.find((a) => a.code === "5110")!.balanceCents;
    const surplus = tb.find((a) => a.code === "4310")!.balanceCents;
    const lent = rows.reduce((s, r) => s + r.principalCents, 0);
    // Rounding, game repayment bugs and cross-loan attribution: small next to what was lent.
    expect(Math.abs(surplus - shortfall)).toBeLessThan(lent * 0.03);
  });

  it("changes nothing when the same paste is committed again", async () => {
    const result = await commitPaste(ceo, { tab: "complete", text: paste("complete") });
    expect(result).toMatchObject({ statusChanges: 0, levyEntries: 0, created: 0 });
    expect(await syncLoans()).toMatchObject({ closingEntries: 0 });
  });

  it("only ever books whole dollars, like the game", async () => {
    const [{ n }] = await db
      .select({ n: count() })
      .from(journalLine)
      .where(sql`(${journalLine.debitCents} + ${journalLine.creditCents}) % 100 <> 0`);
    expect(n).toBe(0);
  });

  it("corrects levies that were posted with cents", async () => {
    // Simulate the earlier rule: a levy of $66.67 where whole-dollar rounding gives $67.
    const [link] = await db.select().from(loanPaymentLink).where(sql`${loanPaymentLink.levyCents} > 0`).limit(1);
    const entryId = crypto.randomUUID();
    await db.transaction(async (tx) => {
      await tx.insert(journalEntry).values({ id: entryId, effectiveAt: new Date(), kind: "adjustment", description: "old cent levy" });
      await tx.insert(journalLine).values([
        { entryId, accountCode: "5100", debitCents: 37, creditCents: 0 },
        { entryId, accountCode: "1100", debitCents: 0, creditCents: 37 },
      ]);
      await tx.update(loanPaymentLink).set({ levyCents: link.levyCents + 37 }).where(eq(loanPaymentLink.bankTransactionId, link.bankTransactionId));
    });

    expect(await syncLoans()).toMatchObject({ levyCorrections: 1 });
    const [after] = await db.select().from(loanPaymentLink).where(eq(loanPaymentLink.bankTransactionId, link.bankTransactionId));
    expect(after.levyCents).toBe(link.levyCents);
    const levyTotal = (await db.select({ s: sql<string>`sum(${loanPaymentLink.levyCents})` }).from(loanPaymentLink))[0].s;
    expect((await trialBalance()).find((a) => a.code === "5100")!.balanceCents).toBe(Number(levyTotal));
    expect(await syncLoans()).toMatchObject({ levyCorrections: 0, closingEntries: 0 });
    expect(await balanced()).toBe(true);
  });

  it("takes back a levy once booked on an early repayment, and the closing surplus that absorbed it", async () => {
    // Before 2026-10-13 an early repayment X carried a levy of Xs as if it came out of principal. The game
    // credits only X(1−b−s) to the loan (Onyx Greystone's card), so that levy was never Litt's cost; on a
    // completed loan the closing step then booked the same amount back as "principal overpaid" surplus.
    const [early] = await db
      .select({ txId: loanPaymentLink.bankTransactionId, loanId: loan.id, amount: sql<string>`b.amount_cents`, b: loan.brokerRateBp, s: loan.stateRateBp })
      .from(loanPaymentLink)
      .innerJoin(loan, eq(loan.id, loanPaymentLink.loanId))
      .innerJoin(sql`bank_transaction b`, sql`b.id = ${loanPaymentLink.bankTransactionId}`)
      .where(and(eq(loanPaymentLink.role, "early_principal"), eq(loan.status, "completed"), sql`${loan.stateRateBp} > 0`))
      .limit(1);
    expect(early).toBeDefined();
    const before = await trialBalance();
    const bal = (tb: typeof before, code: string) => tb.find((a) => a.code === code)?.balanceCents ?? 0;
    const oldLevy = Math.round((Number(early.amount) * (early.s! / 10_000)) / (1 - early.b! / 10_000 - early.s! / 10_000) / 100) * 100;
    expect(oldLevy).toBeGreaterThan(0);

    await db.transaction(async (tx) => {
      const levyEntry = crypto.randomUUID();
      await tx.insert(journalEntry).values({ id: levyEntry, effectiveAt: new Date(), kind: "adjustment", description: "State loan levy" });
      await tx.insert(journalLine).values([
        { entryId: levyEntry, accountCode: "5100", debitCents: oldLevy, creditCents: 0 },
        { entryId: levyEntry, accountCode: "1100", debitCents: 0, creditCents: oldLevy },
      ]);
      await tx.update(loanPaymentLink).set({ levyCents: oldLevy, levyEntryId: levyEntry }).where(eq(loanPaymentLink.bankTransactionId, early.txId));
      const closing = crypto.randomUUID();
      await tx.insert(journalEntry).values({ id: closing, effectiveAt: new Date(), kind: "adjustment", description: "Loan closing surplus" });
      await tx.insert(journalLine).values([
        { entryId: closing, accountCode: "1100", debitCents: oldLevy, creditCents: 0 },
        { entryId: closing, accountCode: "4310", debitCents: 0, creditCents: oldLevy },
      ]);
      await tx.execute(sql`insert into loan_adjustment (loan_id, journal_entry_id, kind, amount_cents) values (${early.loanId}, ${closing}, 'closing', ${-oldLevy})`);
    });
    const old = await trialBalance();
    expect(bal(old, "5100")).toBe(bal(before, "5100") + oldLevy);

    expect(await syncLoans()).toMatchObject({ levyCorrections: 1, closingEntries: 1 });
    const [link] = await db.select().from(loanPaymentLink).where(eq(loanPaymentLink.bankTransactionId, early.txId));
    expect(link.levyCents).toBe(0);
    const after = await trialBalance();
    for (const code of ["1100", "4310", "5100", "5110"]) expect([code, bal(after, code)]).toEqual([code, bal(before, code)]);
    expect((await getLoan(ceo, early.loanId))?.outstandingCents).toBe(0);
    expect(await syncLoans()).toMatchObject({ levyCorrections: 0, closingEntries: 0 });
    expect(await balanced()).toBe(true);
  });

  it("books the +2% overdue penalty inside instalments as a late fee, and takes it back out of a closing surplus", async () => {
    // Owner 2026-10-13 (audit F5): the game adds 2% per missed payment to later instalments; that part isn't principal.
    const [pen] = await db
      .select({ txId: loanPaymentLink.bankTransactionId, loanId: loan.id, penalty: loanPaymentLink.penaltyCents })
      .from(loanPaymentLink)
      .innerJoin(loan, eq(loan.id, loanPaymentLink.loanId))
      .where(and(sql`${loanPaymentLink.penaltyCents} > 0`, eq(loan.status, "completed")))
      .limit(1);
    expect(pen).toBeDefined();
    const before = await trialBalance();
    const bal = (tb: typeof before, code: string) => tb.find((a) => a.code === code)?.balanceCents ?? 0;
    // Booked on import: a late-fee entry against the receivable.
    const [{ n }] = await db.select({ n: count() }).from(journalEntry).where(and(eq(journalEntry.bankTransactionId, pen.txId), eq(journalEntry.description, "Overdue penalty on an instalment")));
    expect(n).toBe(1);

    // The old state: no penalty booked, and the closing step absorbed it as surplus.
    await db.transaction(async (tx) => {
      const undo = crypto.randomUUID();
      const closing = crypto.randomUUID();
      await tx.insert(journalEntry).values([
        { id: undo, effectiveAt: new Date(), kind: "adjustment", description: "old: penalty counted as principal" },
        { id: closing, effectiveAt: new Date(), kind: "adjustment", description: "Loan closing surplus" },
      ]);
      await tx.insert(journalLine).values([
        { entryId: undo, accountCode: "4000", debitCents: pen.penalty, creditCents: 0 },
        { entryId: undo, accountCode: "1100", debitCents: 0, creditCents: pen.penalty },
        { entryId: closing, accountCode: "1100", debitCents: pen.penalty, creditCents: 0 },
        { entryId: closing, accountCode: "4310", debitCents: 0, creditCents: pen.penalty },
      ]);
      await tx.execute(sql`insert into loan_adjustment (loan_id, journal_entry_id, kind, amount_cents) values (${pen.loanId}, ${closing}, 'closing', ${-pen.penalty})`);
      await tx.update(loanPaymentLink).set({ penaltyCents: 0 }).where(eq(loanPaymentLink.bankTransactionId, pen.txId));
    });
    expect(bal(await trialBalance(), "4310")).toBe(bal(before, "4310") + pen.penalty);

    expect(await syncLoans()).toMatchObject({ penaltyEntries: 1, closingEntries: 1 });
    const after = await trialBalance();
    for (const code of ["1100", "4000", "4310", "5100", "5110"]) expect([code, bal(after, code)]).toEqual([code, bal(before, code)]);
    expect((await getLoan(ceo, pen.loanId))?.outstandingCents).toBe(0);
    expect(await syncLoans()).toMatchObject({ penaltyEntries: 0, levyCorrections: 0, closingEntries: 0 });
    expect(await balanced()).toBe(true);
  });

  it("moves an old early-repayment levy on a written-off loan to credit losses, not back onto the receivable", async () => {
    // Kendall Larkspur's loan (live): written off with a $15 levy on an early repayment, so the write-off was $15 short.
    const [early] = await db
      .select({ txId: loanPaymentLink.bankTransactionId, loanId: loan.id })
      .from(loanPaymentLink)
      .innerJoin(loan, eq(loan.id, loanPaymentLink.loanId))
      .where(and(eq(loanPaymentLink.role, "early_principal"), eq(loan.status, "completed"), sql`${loan.stateRateBp} > 0`))
      .offset(1)
      .limit(1);
    const before = await trialBalance();
    const bal = (tb: typeof before, code: string) => tb.find((a) => a.code === code)?.balanceCents ?? 0;
    const levy = 1_500;
    await db.transaction(async (tx) => {
      await tx.update(loan).set({ status: "written_off" }).where(eq(loan.id, early.loanId));
      const levyEntry = crypto.randomUUID();
      const smallerWriteOff = crypto.randomUUID();
      await tx.insert(journalEntry).values([
        { id: levyEntry, effectiveAt: new Date(), kind: "adjustment", description: "State loan levy" },
        { id: smallerWriteOff, effectiveAt: new Date(), kind: "adjustment", description: "Write-off sized from the old levy" },
      ]);
      await tx.insert(journalLine).values([
        { entryId: levyEntry, accountCode: "5100", debitCents: levy, creditCents: 0 },
        { entryId: levyEntry, accountCode: "1100", debitCents: 0, creditCents: levy },
        { entryId: smallerWriteOff, accountCode: "1100", debitCents: levy, creditCents: 0 },
        { entryId: smallerWriteOff, accountCode: "5300", debitCents: 0, creditCents: levy },
      ]);
      await tx.update(loanPaymentLink).set({ levyCents: levy, levyEntryId: levyEntry }).where(eq(loanPaymentLink.bankTransactionId, early.txId));
    });

    expect(await syncLoans()).toMatchObject({ levyCorrections: 1 });
    const after = await trialBalance();
    for (const code of ["1100", "5100", "5300"]) expect([code, bal(after, code)]).toEqual([code, bal(before, code)]);

    await db.update(loan).set({ status: "completed" }).where(eq(loan.id, early.loanId));
    expect(await syncLoans()).toMatchObject({ levyCorrections: 0, closingEntries: 0 });
    expect(await balanced()).toBe(true);
  });
});

describe("officers and visibility", () => {
  let mine: string;

  it("lets an officer claim an unassigned loan, but only for themselves", async () => {
    const [l] = await listLoans(ceo, { status: "open", officer: "unassigned" });
    mine = l.id;
    await expect(assignOfficer(officer, { loanId: mine, officerStaffId: otherOfficer.staffId })).rejects.toThrow(/only claim/);
    await assignOfficer(officer, { loanId: mine, officerStaffId: officer.staffId });
    await expect(assignOfficer(otherOfficer, { loanId: mine, officerStaffId: otherOfficer.staffId })).rejects.toThrow(/only claim/);
  });

  it("requires a reason to change an existing officer", async () => {
    await expect(assignOfficer(ceo, { loanId: mine, officerStaffId: otherOfficer.staffId })).rejects.toThrow(/reason/);
  });

  it("shows officers their own loans only", async () => {
    const list = await listLoans(officer, { status: "all" });
    expect(list.map((l) => l.id)).toEqual([mine]);
    expect(await getLoan(otherOfficer, mine)).toBeNull();
    expect(await getLoan(officer, mine)).not.toBeNull();
    expect((await listLoans(ceo, { status: "all" })).length).toBe(85);
  });

  it("gives any officer a borrower history summary without links to others' loans", async () => {
    const detail = (await getLoan(ceo, mine))!;
    const summary = (await borrowerSummary(otherOfficer, detail.loan.borrowerStateId))!;
    expect(summary.totals.count).toBeGreaterThanOrEqual(1);
    expect(summary.loans.every((l) => l.id === null)).toBe(true);
  });
});

describe("write-off", () => {
  let defaulted: typeof loan.$inferSelect;

  beforeAll(async () => {
    [defaulted] = await db.select().from(loan).where(eq(loan.status, "defaulted")).limit(1);
  });

  it("needs a fresh step-up", async () => {
    await expect(writeOffLoan(ceo, { loanId: defaulted.id, reason: "Borrower unreachable" })).rejects.toBeInstanceOf(StepUpRequiredError);
  });

  it("is refused for officers and before the 28-day wait", async () => {
    const fresh = { ...ceo, stepUpAt: new Date().toISOString() };
    await expect(writeOffLoan({ ...officer, stepUpAt: fresh.stepUpAt }, { loanId: defaulted.id, reason: "Borrower unreachable" })).rejects.toThrow(/permission/);
    await db.update(loan).set({ firstDefaultAt: new Date() }).where(eq(loan.id, defaulted.id));
    await expect(writeOffLoan(fresh, { loanId: defaulted.id, reason: "Borrower unreachable" })).rejects.toThrow(/can be written off from/);
  });

  it("charges off the outstanding principal to credit losses", async () => {
    await db.update(loan).set({ firstDefaultAt: new Date(Date.now() - 40 * 86_400_000) }).where(eq(loan.id, defaulted.id));
    const fresh = { ...ceo, stepUpAt: new Date().toISOString() };
    const before = (await getLoan(ceo, defaulted.id))!.outstandingCents!;
    expect(before).toBeGreaterThan(0);
    const receivableBefore = await receivable();

    const { amountCents, entryId } = await writeOffLoan(fresh, { loanId: defaulted.id, reason: "Borrower unreachable for 6 weeks" });
    expect(amountCents).toBe(before);
    expect(await receivable()).toBe(receivableBefore - before);
    expect((await trialBalance()).find((a) => a.code === "5300")!.balanceCents).toBe(before);
    const lines = await db.select().from(journalLine).where(eq(journalLine.entryId, entryId));
    expect(lines).toHaveLength(2);

    const after = (await getLoan(ceo, defaulted.id))!;
    expect(after.loan.status).toBe("written_off");
    expect(after.events[0]).toMatchObject({ kind: "written_off" });
    await expect(writeOffLoan(fresh, { loanId: defaulted.id, reason: "again" })).rejects.toThrow();

    const [event] = await db.select().from(auditEvent).where(inArray(auditEvent.action, ["loans.written_off"]));
    expect(event).toMatchObject({ targetId: defaulted.id, reason: "Borrower unreachable for 6 weeks" });
    expect(await balanced()).toBe(true);
  });

  it("keeps a write-off when a later paste still shows the loan", async () => {
    await commitPaste(ceo, { tab: "default", text: paste("default") });
    const [row] = await db.select({ status: loan.status }).from(loan).where(eq(loan.id, defaulted.id));
    expect(row.status).toBe("written_off");
  });

  it("summarises the book", async () => {
    const k = await loanKpis(ceo);
    const live = await db.select({ n: count() }).from(loan).where(inArray(loan.status, ["active", "overdue"]));
    expect(k.open).toBe(live[0].n);
    expect(k.outstandingLiveCents).toBeGreaterThan(0);
    expect(k.outstandingLiveCents).toBeLessThan(k.outstandingCents);
    expect(k.outstandingCents).toBeGreaterThan(0);
  });
});

describe("default dates for old-version cards (no 'First missed payment' line)", () => {
  it("are worked out from missed payments, not the day the card was pasted", async () => {
    const [row] = (
      await db.execute<{ id: string; base: Date }>(sql`
        select l.id, coalesce((select max(b.occurred_at) from loan_payment_link k join bank_transaction b on b.id = k.bank_transaction_id
                               where k.loan_id = l.id and k.role in ('principal','early_principal','late_principal')), l.opened_at) as base
        from loan l
        where l.status = 'defaulted' and l.period_days is null
        limit 1`)
    ).rows;
    expect(row).toBeDefined();
    // Make its cards look like an old-version card: no "First missed payment" line.
    await db.execute(sql`update loan_card set parsed = parsed - 'firstMissedAt' where loan_id = ${row.id}`);
    // As the earlier code did: defaulted "today" because nothing dated it.
    await db.update(loan).set({ firstDefaultAt: new Date() }).where(eq(loan.id, row.id));
    await syncLoans();
    const [after] = await db.select().from(loan).where(eq(loan.id, row.id));
    // Three missed weekly payments after the last one paid (or after it started, if none were).
    expect(after.firstDefaultAt!.getTime()).toBe(new Date(row.base).getTime() + 21 * 86_400_000);
    const [event] = await db.select().from(loanEvent).where(and(eq(loanEvent.loanId, row.id), eq(loanEvent.kind, "default_date_corrected")));
    expect(event).toBeDefined();
    const again = await syncLoans();
    expect(again.loansCreated).toBe(0);
    const [still] = await db.select().from(loan).where(eq(loan.id, row.id));
    expect(still.firstDefaultAt).toEqual(after.firstDefaultAt);
  });
});

describe("loans repaid but stuck in the game's Default tab", () => {
  it("can be marked repaid when the books agree, and stay that way through later pastes", async () => {
    const { markRepaid } = await import("@/server/loans/service");
    const defaulted = await listLoans(ceo, { status: "defaulted" });
    const repaid = defaulted.find((l) => l.outstandingCents !== null && l.outstandingCents <= 10_000);
    const owing = defaulted.find((l) => (l.outstandingCents ?? 0) > 10_000);
    expect(repaid).toBeDefined();
    expect(owing).toBeDefined();

    await expect(markRepaid(officer, { loanId: repaid!.id, reason: "Paid off early" })).rejects.toThrow(/permission/);
    // It books what's left (up to $100) as a loss, so it needs a fresh step-up (review 2026-10-13).
    await expect(markRepaid(ceo, { loanId: repaid!.id, reason: "Paid off early" })).rejects.toBeInstanceOf(StepUpRequiredError);
    const fresh = { ...ceo, stepUpAt: new Date().toISOString() };
    await expect(markRepaid(fresh, { loanId: owing!.id, reason: "Paid off early" })).rejects.toThrow(/still show/);

    await markRepaid(fresh, { loanId: repaid!.id, reason: "Paid off early; game bug kept it in Default" });
    const [after] = await db.select().from(loan).where(eq(loan.id, repaid!.id));
    expect(after).toMatchObject({ status: "completed", statusLocked: true, statusLockReason: "Paid off early; game bug kept it in Default" });
    expect(after.completedAt).not.toBeNull();
    expect((await listLoans(ceo, { status: "completed" })).find((l) => l.id === repaid!.id)?.outstandingCents).toBe(0);

    // The game still shows it in Default: a fresh paste must not move it back.
    await commitPaste(ceo, { tab: "default", text: paste("default") });
    const [still] = await db.select().from(loan).where(eq(loan.id, repaid!.id));
    expect(still.status).toBe("completed");
    expect(await db.select().from(auditEvent).where(eq(auditEvent.action, "loans.marked_repaid"))).toHaveLength(1);
  });
});

describe("invited staff", () => {
  it("can be made officer before they accept their invite; departed staff can't", async () => {
    const { activeStaffOptions } = await import("@/server/loans/queries");
    const [invited] = await db.insert(staff).values({ stateId: 717171, characterName: "Invited Ivy", role: "loan_officer", status: "invited" }).returning();
    const [gone] = await db.insert(staff).values({ stateId: 818181, characterName: "Departed Dan", role: "loan_officer", status: "departed" }).returning();
    const [l] = await listLoans(ceo, { status: "open", officer: "unassigned" });
    await expect(assignOfficer(ceo, { loanId: l.id, officerStaffId: gone.id })).rejects.toThrow(/current staff/);
    await assignOfficer(ceo, { loanId: l.id, officerStaffId: invited.id });
    expect((await getLoan(ceo, l.id))!.loan.officerStaffId).toBe(invited.id);
    const options = await activeStaffOptions();
    expect(options).toEqual(expect.arrayContaining([{ id: invited.id, name: "Invited Ivy (invite pending)" }]));
    expect(options.some((o) => o.id === gone.id)).toBe(false);
  });
});

describe("departed staff", () => {
  it("can be named on finished loans only", async () => {
    const { activeStaffOptions } = await import("@/server/loans/queries");
    const [jake] = await db.insert(staff).values({ stateId: 919191, characterName: "Jake Former", role: "loan_officer", status: "departed" }).returning();
    const [open] = await listLoans(ceo, { status: "open", officer: "unassigned" });
    await expect(assignOfficer(ceo, { loanId: open.id, officerStaffId: jake.id })).rejects.toThrow(/finished loans/);
    const done = (await listLoans(ceo, { status: "completed" })).find((l) => l.officerStaffId === null)!;
    await assignOfficer(ceo, { loanId: done.id, officerStaffId: jake.id });
    expect((await getLoan(ceo, done.id))!.loan.officerStaffId).toBe(jake.id);
    expect((await activeStaffOptions()).some((o) => o.id === jake.id)).toBe(false);
    expect(await activeStaffOptions({ finished: true })).toEqual(expect.arrayContaining([{ id: jake.id, name: "Jake Former (departed)" }]));
  });
});

describe("can we lend?", () => {
  it("shows red flags from history and a do-not-lend mark, which management can set and clear", async () => {
    const { lendingCheck, setDoNotLend, clearDoNotLend } = await import("@/server/loans/lending");
    const [bad] = await db.select().from(loan).where(eq(loan.status, "written_off")).limit(1);
    const before = await lendingCheck(officer, bad.borrowerStateId, { amountCents: 1_000_000, rateBp: 2000 });
    expect(before.flags.some((f) => f.level === "danger" && /written off/.test(f.text))).toBe(true);
    expect(before.record.overall.loans).toBeGreaterThan(0);

    await expect(setDoNotLend(officer, { stateId: bad.borrowerStateId, reason: "Wrote off their loan" })).rejects.toThrow(/permission/);
    await setDoNotLend(ceo, { stateId: bad.borrowerStateId, reason: "Wrote off their loan" });
    await expect(setDoNotLend(ceo, { stateId: bad.borrowerStateId, reason: "Wrote off their loan" })).rejects.toThrow(/already/);
    const flagged = await lendingCheck(officer, bad.borrowerStateId, {});
    expect(flagged.flags[0]).toEqual({ level: "danger", text: "Marked do not lend by Loan Tester: Wrote off their loan" });

    await clearDoNotLend(ceo, { stateId: bad.borrowerStateId, reason: "Settled the debt in full" });
    expect((await lendingCheck(officer, bad.borrowerStateId, {})).doNotLend).toBeNull();
    const audits = await db.select({ action: auditEvent.action }).from(auditEvent).where(inArray(auditEvent.action, ["borrowers.flag.set", "borrowers.flag.cleared"]));
    expect(audits).toHaveLength(2);

    // Someone new: no history at all.
    expect((await lendingCheck(officer, 9_999_998, {})).flags).toEqual([{ level: "info", text: "First-time borrower: no history with Litt's" }]);
  });
});

describe("collections", () => {
  it("logs contacts and promises on defaulted loans, and the queue shows what's due", async () => {
    const { collectionsQueue, logCollection, loanCollections } = await import("@/server/loans/collections");
    const now = new Date();
    const queue = await collectionsQueue(ceo, now);
    const target = queue.find((r) => r.status === "defaulted")!;
    expect(target).toMatchObject({ due: true, last: null });

    // Officers can only log on their own loans; Legal+ on any.
    await expect(logCollection(otherOfficer, { loanId: target.id, kind: "contacted", note: "Spoke to them" })).rejects.toThrow(/officer, Legal or management/);
    await expect(logCollection(ceo, { loanId: target.id, kind: "promise", note: "Says Friday" })).rejects.toThrow(/amount and a date/);
    await logCollection(ceo, { loanId: target.id, kind: "promise", note: "Says Friday", promiseDollars: 5000, promiseBy: "2099-01-02" });

    const [entry] = (await loanCollections([target.id])).get(target.id)!;
    expect(entry).toMatchObject({ kind: "promise", promiseCents: 500_000, staffName: "Loan Tester" });
    expect(entry.nextActionAt?.toISOString().slice(0, 10)).toBe("2099-01-02"); // follow up on the promised day
    expect((await collectionsQueue(ceo, now)).find((r) => r.id === target.id)).toMatchObject({ due: false });

    const [done] = await listLoans(ceo, { status: "completed" });
    await expect(logCollection(ceo, { loanId: done.id, kind: "note", note: "Hello" })).rejects.toThrow(/only apply/);
    await expect(db.execute(sql`delete from loan_collection_action`)).rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringMatching(/immutable|append-only/) }) });
  });
});

describe("settlement payments on a defaulted loan (Arlo Oswin — 'Arlo Oswin' in the fixture)", () => {
  it("refiled as recoveries, they link to the loan and the old-loans close-out is corrected", async () => {
    const { reclassifyTransaction } = await import("@/server/bank/reclassify");
    const { closeLegacyClearing, legacyClearing } = await import("@/server/ledger/legacy");
    const { loanProfits } = await import("@/server/profit");
    const { bankTransaction: bt, journalEntry: je, journalLine: jl } = await import("@/server/db/schema");
    const fresh = { ...ceo, stepUpAt: new Date().toISOString() };
    const balance = async (code: string) => Number((await db.execute<{ b: string }>(sql`select coalesce(sum(debit_cents - credit_cents), 0) as b from journal_line where account_code = ${code}`)).rows[0].b);

    // As in production: the old manual loans were closed out with these payments still in 1190.
    await closeLegacyClearing(fresh, { reason: "All old manual loans finished" });
    expect(await balance("1190")).toBe(0);
    const [{ closedAt }] = (await db.execute<{ closedAt: Date }>(sql`select max(e.effective_at) as "closedAt" from journal_entry e join journal_line l on l.entry_id = e.id where l.account_code = '4020'`)).rows;
    const income = -(await balance("4020"));

    const rows = await db.select().from(bt).where(sql`${bt.comment} ilike 'Charge Arlo Oswin%'`);
    expect(rows).toHaveLength(6);
    const gross = rows.reduce((s, r) => s + r.amountCents, 0);
    expect(gross).toBe(4_037_600);
    const [arlo] = await db.select().from(loan).where(eq(loan.borrowerName, "Arlo Oswin"));
    const before = (await loanProfits()).get(arlo.id) ?? 0;

    for (const r of rows) await reclassifyTransaction(ceo, { transactionId: r.id, category: "recovery.settlement", reason: "Court settlement payments (owner)" });
    const links = await db.select().from(loanPaymentLink).where(eq(loanPaymentLink.loanId, arlo.id));
    expect(links.filter((l) => l.role === "recovery").map((l) => l.bankTransactionId).sort()).toEqual(rows.map((r) => r.id).sort());
    expect(links.find((l) => l.role === "recovery")?.method).toBe("borrower_named");
    // Recoveries don't touch the receivable or the levy.
    expect(links.filter((l) => l.role === "recovery").every((l) => l.levyCents === 0 && l.levyEntryId === null)).toBe(true);
    // Net to Litt's now includes them (gross less tax withheld).
    const tax = rows.reduce((s, r) => s + r.taxCents, 0);
    expect((await loanProfits()).get(arlo.id)).toBe(before + gross - tax);

    // 1190 now shows the moved-out money; the close-out is corrected out of 4020, dated with it.
    expect(await balance("1190")).toBe(gross);
    expect((await legacyClearing()).bookedIncomeCents).toBe(income);
    const lossBefore = await balance("5300");
    const { entryId } = await closeLegacyClearing(fresh, { reason: "Arlo's settlement payments were recoveries" });
    expect(await balance("1190")).toBe(0);
    expect(-(await balance("4020"))).toBe(income - gross);
    expect(await balance("5300")).toBe(lossBefore); // no new loss booked
    const lines = await db.select().from(jl).where(eq(jl.entryId, entryId));
    expect(lines.map((l) => [l.accountCode, l.debitCents, l.creditCents]).sort()).toEqual([
      ["1190", 0, gross],
      ["4020", gross, 0],
    ]);
    const [entry] = await db.select().from(je).where(eq(je.id, entryId));
    expect(entry.effectiveAt.getTime()).toBe(new Date(closedAt).getTime());
    const tb = await db.execute(sql`select sum(debit_cents) = sum(credit_cents) as ok from journal_line`);
    expect(tb.rows[0].ok).toBe(true);
  });
});

describe("QA regressions", () => {
  it("refuses a cut-off phone card instead of reading it as a tab", async () => {
    await expect(previewPaste(ceo, { tab: "active", text: "$9,874.00\n69811362\n2932\nTYPE loan" })).rejects.toThrow(/looks cut off/);
  });

  it("won't take a promise or follow-up dated in the past", async () => {
    const { logCollection } = await import("@/server/loans/collections");
    const [l] = await listLoans(ceo, { status: "defaulted" });
    await expect(logCollection(ceo, { loanId: l.id, kind: "promise", note: "Says soon", promiseDollars: 500, promiseBy: "2001-01-01" })).rejects.toThrow(/can't be in the past/);
    await expect(logCollection(ceo, { loanId: l.id, kind: "contacted", note: "Spoke", nextActionAt: "2001-01-01" })).rejects.toThrow(/can't be in the past/);
  });
});

describe("next payment (QA 2026-10-13: the same phone text pasted 1 h 45 m apart)", () => {
  const nextDue = async () =>
    new Map(
      (await db.select({ id: loan.id, next: loan.nextPaymentDueAt }).from(loan).where(and(eq(loan.status, "active"), sql`${loan.disbursementTxId} is not null`))).map((l) => [
        l.id,
        l.next?.getTime() ?? null,
      ]),
    );

  it("is the game's due date from the bank for running loans", async () => {
    const { nextPaymentDue } = await import("@/domain/loans/analysis");
    const rows = await db.select().from(loan).where(and(eq(loan.status, "active"), sql`${loan.disbursementTxId} is not null`, sql`${loan.instalments} is not null`));
    expect(rows.length).toBeGreaterThan(0);
    for (const l of rows) {
      const paid = await db
        .select({ at: sql<Date>`b.occurred_at` })
        .from(loanPaymentLink)
        .innerJoin(sql`bank_transaction b`, sql`b.id = ${loanPaymentLink.bankTransactionId}`)
        .where(and(eq(loanPaymentLink.loanId, l.id), inArray(loanPaymentLink.role, ["principal", "late_principal"])));
      const paidAt = paid.map((p) => new Date(p.at)).sort((a, b) => a.getTime() - b.getTime());
      if ((l.lastCompleted ?? 0) > paidAt.length) continue; // the phone is ahead of the bank: the card's estimate stands
      const expected = nextPaymentDue({ openedAt: l.openedAt!, periodDays: l.periodDays ?? 7, instalments: l.instalments! }, paidAt, { completed: l.lastCompleted, estimate: null });
      expect(l.nextPaymentDueAt?.getTime() ?? null).toBe(expected?.getTime() ?? null);
    }
  });

  it("warns when the same text is pasted again after its countdowns should have moved, and moves nothing", async () => {
    // The previous Active paste was two hours ago.
    await db.execute(sql`update loan_paste set captured_at = captured_at - interval '2 hours'
      where id = (select id from loan_paste where tab = 'active' order by captured_at desc limit 1)`);
    const preview = await previewPaste(ceo, { tab: "active", text: paste("active") });
    expect(preview.repeatOf).not.toBeNull();
    const before = await nextDue();
    await commitPaste(ceo, { tab: "active", text: paste("active") });
    expect(await nextDue()).toEqual(before);
    // Pasted again straight away: too soon to tell, so no warning.
    expect((await previewPaste(ceo, { tab: "active", text: paste("active") })).repeatOf).toBeNull();
  });
});

describe("notes", () => {
  it("are audited like every other change (review 2026-10-13)", async () => {
    const { addLoanNote } = await import("@/server/loans/service");
    const target = (await listLoans(ceo, { status: "all" })).find((l) => l.officerStaffId !== officer.staffId)!;
    await expect(addLoanNote(officer, { loanId: target.id, text: "Not my loan" })).rejects.toThrow(/permission/);
    await addLoanNote(ceo, { loanId: target.id, text: "Called; says Friday" });
    const [event] = await db.select().from(auditEvent).where(eq(auditEvent.action, "loans.note_added"));
    expect(event).toMatchObject({ targetType: "loan", targetId: target.id, metadata: expect.objectContaining({ length: 19 }) });
  });
});
