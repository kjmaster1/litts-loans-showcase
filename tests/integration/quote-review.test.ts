import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/request", () => ({ getRequestMeta: async () => ({ ip: "203.0.113.10", userAgent: "vitest" }) }));

/** Review notes and executive approval on quotes and mortgages (owner, 2026-10-15; research/18). */

const { saveQuote, cancelQuote, getQuote, inputOf } = await import("@/server/origination/mortgage-quotes");
const { addQuoteNote, approveQuote, openNoteCounts, quoteNotes, resolveQuoteNote } = await import("@/server/origination/quote-review");
const { approveMortgageAfter, previewApprovalFlag } = await import("@/server/mortgages/approval");
const { getMortgage, listMortgages } = await import("@/server/mortgages/queries");
const { notificationsFor } = await import("@/server/notifications");
const { quoteMortgage } = await import("@/domain/origination/mortgage-quote");
const { EXECUTIVE_APPROVAL_FROM } = await import("@/domain/mortgages/approval");
const { DEFAULT_SETTINGS } = await import("@/domain/settings");
const { db } = await import("@/server/db");
const { auditEvent, mortgage, mortgageEvent, mortgageQuote, mortgageQuoteNote, staff } = await import("@/server/db/schema");
const { resetDb } = await import("../support/db");

type Viewer = import("@/server/authz/viewer").Viewer;
let ceo: Viewer;
let manager: Viewer;
let officer: Viewer;
let other: Viewer;

async function makeViewer(stateId: number, name: string, role: Viewer["role"]): Promise<Viewer> {
  const [row] = await db.insert(staff).values({ stateId, characterName: name, role, status: "active" }).returning();
  return { staffId: row.id, userId: `u-${stateId}`, sessionId: `s-${stateId}`, role, characterName: name, stateId, username: name, twoFactorEnabled: true, stepUpAt: null, tourCompletedAt: null, tourRole: null };
}

/** $1,250,000 down payment + loan: over the $1,000,000 line, in the up-to-$2m federal band (3% fee, 7% broker). */
const big = {
  buyerStateId: 40001,
  buyerName: "Avery Lane",
  address: "1 Large Estate Rd",
  priceDollars: 1_300_000,
  agencyCommissionDollars: 50_000,
  downPaymentPct: 10,
  termMonths: 12,
  fedRatePct: 3,
  brokerRatePct: 6,
  bankerFeePct: 3,
  primaryResidence: true,
};
const small = { ...big, address: "2 Small Cottage Ln", priceDollars: 500_000, agencyCommissionDollars: 25_000, bankerFeePct: 5 };

const kinds = async (v: Viewer) => (await notificationsFor(v)).map((n) => `${n.kind}:${n.href}`);
const quoteRow = async (id: string) => (await db.select().from(mortgageQuote).where(eq(mortgageQuote.id, id)))[0];

beforeAll(async () => {
  await resetDb();
  ceo = await makeViewer(3454, "Kieran Jones", "ceo");
  manager = await makeViewer(70010, "Zion Pemberton", "management");
  officer = await makeViewer(70011, "Skyler Marlowe", "loan_officer");
  other = await makeViewer(70012, "Otto Other", "loan_officer");
});

describe("executive approval of large quotes", () => {
  it("an officer's quote over $1,000,000 waits for an executive; management can't approve it", async () => {
    const id = await saveQuote(officer, big);
    expect(await quoteRow(id)).toMatchObject({ approvedAt: null, approvedByStaffId: null });
    expect(await kinds(ceo)).toContain(`quote_approval:/mortgages/quotes/${id}`);
    expect(await kinds(manager)).not.toContain(`quote_approval:/mortgages/quotes/${id}`);
    await expect(approveQuote(officer, { id })).rejects.toThrow(/Only an executive/);
    await expect(approveQuote(manager, { id })).rejects.toThrow(/Only an executive/);

    await approveQuote(ceo, { id });
    expect(await quoteRow(id)).toMatchObject({ approvedByStaffId: ceo.staffId });
    expect(await getQuote(officer, id)).toMatchObject({ approvedByName: "Kieran Jones" });
    await expect(approveQuote(ceo, { id })).rejects.toThrow("This quote is already approved.");
    expect(await kinds(ceo)).not.toContain(`quote_approval:/mortgages/quotes/${id}`);
    // The officer hears it can go on the tablet.
    expect(await kinds(officer)).toContain(`quote_approved:/mortgages/quotes/${id}`);
    const [audit] = await db.select().from(auditEvent).where(and(eq(auditEvent.action, "mortgages.quote.approved"), eq(auditEvent.targetId, id)));
    expect(audit).toBeDefined();
  });

  it("keeps the approval for a note or spelling fix, clears it when the terms change", async () => {
    const id = await saveQuote(officer, big);
    await approveQuote(ceo, { id });
    await saveQuote(officer, { ...big, buyerName: "Avery Lane-Smith", notes: "Buyer prefers Fridays" }, id);
    expect((await quoteRow(id)).approvedAt).not.toBeNull();
    await saveQuote(officer, { ...big, bankerFeePct: 2.5 }, id);
    expect(await quoteRow(id)).toMatchObject({ approvedAt: null, approvedByStaffId: null });
    const updates = await db.select().from(auditEvent).where(and(eq(auditEvent.action, "mortgages.quote.updated"), eq(auditEvent.targetId, id)));
    expect(updates.map((u) => (u.metadata as { approval?: string }).approval)).toContain("cleared");
    // Back in the executives' bell.
    expect(await kinds(ceo)).toContain(`quote_approval:/mortgages/quotes/${id}`);
  });

  it("an executive's own save approves it; under the line nothing is needed", async () => {
    const own = await saveQuote(ceo, { ...big, address: "3 Executive Way" });
    expect(await quoteRow(own)).toMatchObject({ approvedByStaffId: ceo.staffId });
    // An executive changing an officer's quote approves what they saved.
    const theirs = await saveQuote(officer, { ...big, address: "4 Officer Row" });
    await saveQuote(ceo, { ...big, address: "4 Officer Row", bankerFeePct: 2 }, theirs);
    expect(await quoteRow(theirs)).toMatchObject({ approvedByStaffId: ceo.staffId });

    const under = await saveQuote(officer, small);
    expect((await quoteRow(under)).approvedAt).toBeNull();
    await expect(approveQuote(ceo, { id: under })).rejects.toThrow("This quote doesn’t need an executive’s approval.");
    // Dropping under the line clears an old approval rather than keeping a stale one.
    await saveQuote(ceo, { ...small, address: "4 Officer Row" }, theirs);
    expect((await quoteRow(theirs)).approvedAt).toBeNull();
  });

  it("a closed quote can't be approved", async () => {
    const id = await saveQuote(officer, { ...big, address: "5 Walked Away Ave" });
    await cancelQuote(officer, { id, reason: "Buyer walked away" });
    await expect(approveQuote(ceo, { id })).rejects.toThrow("This quote is closed.");
  });
});

describe("review notes", () => {
  let id: string;
  beforeAll(async () => {
    id = await saveQuote(officer, { ...small, address: "10 Review Rd" });
  });

  it("management leave notes on a colleague's quote; officers and their own quotes can't", async () => {
    await addQuoteNote(manager, { quoteId: id, text: "Banker fee is too high for this buyer. Lower it to 4%." });
    await expect(addQuoteNote(other, { quoteId: id, text: "Looks wrong" })).rejects.toThrow(/Only management/);
    await expect(addQuoteNote(officer, { quoteId: id, text: "Note to self" })).rejects.toThrow(/Only management/);
    const mine = await saveQuote(manager, { ...small, address: "11 Manager St" });
    await expect(addQuoteNote(manager, { quoteId: mine, text: "Note to self" })).rejects.toThrow(/Only management/);
    await expect(addQuoteNote(manager, { quoteId: id, text: "x" })).rejects.toThrow();

    const notes = await quoteNotes(officer, id);
    expect(notes).toEqual([expect.objectContaining({ text: "Banker fee is too high for this buyer. Lower it to 4%.", staffName: "Zion Pemberton", done: null })]);
    expect((await openNoteCounts([id])).get(id)).toBe(1);
    expect(await kinds(officer)).toContain(`quote_changes:/mortgages/quotes/${id}`);
    expect(await kinds(other)).not.toContain(`quote_changes:/mortgages/quotes/${id}`);
  });

  it("the officer marks it done with a reply; the author hears back; it can't be done twice", async () => {
    const [note] = await quoteNotes(officer, id);
    await expect(resolveQuoteNote(other, { noteId: note.id, reply: "Not mine" })).rejects.toThrow(/Only the quote’s officer or management/);
    await resolveQuoteNote(officer, { noteId: note.id, reply: "Fee lowered to 4%" });
    await expect(resolveQuoteNote(officer, { noteId: note.id })).rejects.toThrow("That note is already done.");

    const [done] = await quoteNotes(officer, id);
    expect(done.done).toMatchObject({ staffName: "Skyler Marlowe", reply: "Fee lowered to 4%" });
    expect((await openNoteCounts([id])).get(id)).toBeUndefined();
    expect(await kinds(officer)).not.toContain(`quote_changes:/mortgages/quotes/${id}`);
    const reply = (await notificationsFor(manager)).find((n) => n.kind === "quote_reply" && n.href === `/mortgages/quotes/${id}`);
    expect(reply).toMatchObject({ title: "Skyler Marlowe replied on quote #" + (await quoteRow(id)).number, detail: "Fee lowered to 4%" });
  });

  it("are kept: a closed quote takes no new notes, and rows can't be changed or deleted", async () => {
    await addQuoteNote(manager, { quoteId: id, text: "Also check the term." });
    await cancelQuote(officer, { id, reason: "Buyer chose cash" });
    await expect(addQuoteNote(manager, { quoteId: id, text: "Too late" })).rejects.toThrow("This quote is closed.");
    const open = (await quoteNotes(officer, id)).find((n) => !n.done)!;
    await expect(resolveQuoteNote(officer, { noteId: open.id })).rejects.toThrow("This quote is closed.");
    // Its notification goes once the quote is closed.
    expect(await kinds(officer)).not.toContain(`quote_changes:/mortgages/quotes/${id}`);
    await expect(db.execute(sql`update mortgage_quote_note set text = 'edited' where id = ${open.id}`)).rejects.toThrow();
    await expect(db.execute(sql`delete from mortgage_quote_note where id = ${open.id}`)).rejects.toThrow();
    expect(await db.select().from(mortgageQuoteNote).where(eq(mortgageQuoteNote.quoteId, id))).toHaveLength(3);
  });
});

describe("mortgages over the line", () => {
  const after = new Date(EXECUTIVE_APPROVAL_FROM.getTime() + 3 * 86_400_000);

  /** A pasted mortgage with exactly a quote's terms. */
  async function mortgageFrom(q: typeof mortgageQuote.$inferSelect, over: Partial<typeof mortgage.$inferInsert> = {}) {
    const f = quoteMortgage(inputOf(q));
    const [m] = await db
      .insert(mortgage)
      .values({
        address: q.address,
        buyerStateId: q.buyerStateId,
        buyerName: q.buyerName,
        officerStaffId: q.officerStaffId,
        originatedAt: after,
        priceCents: q.priceCents,
        agencyCommissionCents: q.agencyCommissionCents,
        downPaymentCents: f.downPaymentCents,
        loanCents: f.loanCents,
        brokerFeeCents: f.bankerFeeCents,
        brokerRateBp: q.brokerRateBp,
        fedRateBp: q.fedRateBp,
        instalments: f.instalments,
        lastTabletAt: after,
        ...over,
      })
      .returning();
    return m;
  }

  it("is flagged and notified when no executive approved it, and approved after the fact by one", async () => {
    const qid = await saveQuote(officer, { ...big, address: "20 Unapproved Ln" });
    const m = await mortgageFrom(await quoteRow(qid));
    await db.update(mortgageQuote).set({ status: "matched", mortgageId: m.id }).where(eq(mortgageQuote.id, qid));

    const detail = (await getMortgage(ceo, m.id))!;
    expect(detail.flags[0]).toMatchObject({ rule: "executive_approval", level: "breach" });
    expect(detail.flags[0].text).toMatch(/wasn’t approved/);
    expect(detail.approval).toMatchObject({ required: true, approved: false });
    expect((await listMortgages(ceo, { status: "all" })).find((r) => r.id === m.id)?.flags.map((f) => f.rule)).toContain("executive_approval");
    expect(await kinds(ceo)).toContain(`unapproved_mortgage:/mortgages/${m.id}`);
    // Names the officer on record when the tablet's officer line wasn't read.
    expect((await notificationsFor(ceo)).find((n) => n.href === `/mortgages/${m.id}`)?.detail).toMatch(/^Arranged by Skyler Marlowe: /);

    await expect(approveMortgageAfter(manager, { mortgageId: m.id, reason: "Looks fine to me" })).rejects.toThrow(/Only an executive/);
    await approveMortgageAfter(ceo, { mortgageId: m.id, reason: "Approved by phone before signing" });
    await expect(approveMortgageAfter(ceo, { mortgageId: m.id, reason: "Approved again" })).rejects.toThrow("This mortgage is already approved.");
    const approved = (await getMortgage(ceo, m.id))!;
    expect(approved.approval).toMatchObject({ approved: true, how: "after_the_fact" });
    expect(approved.approvalEvidence?.approvedAfter?.byName).toBe("Kieran Jones");
    expect(approved.flags.map((f) => f.rule)).not.toContain("executive_approval");
    expect(await kinds(ceo)).not.toContain(`unapproved_mortgage:/mortgages/${m.id}`);
    expect(await db.select().from(mortgageEvent).where(and(eq(mortgageEvent.mortgageId, m.id), eq(mortgageEvent.kind, "executive_approved")))).toHaveLength(1);
  });

  it("is approved by an approved quote it matches, signed after the approval — not if the tablet differs", async () => {
    const qid = await saveQuote(officer, { ...big, address: "21 Approved Ave" });
    await approveQuote(ceo, { id: qid });
    // The approval is dated now; the agreement a few days later.
    const signed = new Date(Date.now() + 86_400_000);
    const m = await mortgageFrom(await quoteRow(qid), { originatedAt: signed });
    await db.update(mortgageQuote).set({ status: "matched", mortgageId: m.id }).where(eq(mortgageQuote.id, qid));
    expect((await getMortgage(ceo, m.id))!.approval).toMatchObject({ approved: true, how: "quote" });

    // A bigger loan typed into the tablet than was approved.
    await db.update(mortgage).set({ loanCents: m.loanCents! + 50_000_000 }).where(eq(mortgage.id, m.id));
    expect((await getMortgage(ceo, m.id))!.approval).toMatchObject({ approved: false, reason: "the agreement differs from approved quote #" + (await quoteRow(qid)).number });

    // Signed before the approval came through.
    const approvedAt = (await quoteRow(qid)).approvedAt!;
    await db.update(mortgage).set({ loanCents: m.loanCents, originatedAt: new Date(approvedAt.getTime() - 60_000) }).where(eq(mortgage.id, m.id));
    expect((await getMortgage(ceo, m.id))!.approval).toMatchObject({ approved: false, reason: expect.stringMatching(/only after the agreement was signed/) });
  });

  it("an executive's own needs nothing; under the line or before the rule nothing is checked", async () => {
    const q = await quoteRow(await saveQuote(officer, { ...big, address: "22 Exec Arranged Rd" }));
    const execs = await mortgageFrom(q, { officerStaffId: ceo.staffId });
    expect((await getMortgage(ceo, execs.id))!.approval).toMatchObject({ approved: true, how: "executive_officer" });
    const old = await mortgageFrom(q, { address: "23 Old Deal Rd", originatedAt: new Date(EXECUTIVE_APPROVAL_FROM.getTime() - 1) });
    expect((await getMortgage(ceo, old.id))!.approval).toEqual({ required: false });
    await expect(approveMortgageAfter(ceo, { mortgageId: old.id, reason: "Not needed really" })).rejects.toThrow("This mortgage doesn’t need an executive’s approval.");
  });

  it("the tablet preview checks the quote the agreement will link to", async () => {
    const qid = await saveQuote(officer, { ...big, address: "24 Preview Pl", buyerStateId: 40077 });
    const q = await quoteRow(qid);
    const f = quoteMortgage(inputOf(q));
    const t = {
      address: q.address,
      buyerStateId: q.buyerStateId,
      officerStaffId: officer.staffId,
      downPaymentCents: f.downPaymentCents,
      loanCents: f.loanCents,
      brokerFeeCents: f.bankerFeeCents,
      brokerRateBp: q.brokerRateBp,
      fedRateBp: q.fedRateBp,
      instalments: f.instalments,
    };
    const g = DEFAULT_SETTINGS.mortgages;
    expect((await previewApprovalFlag(t, null, g))?.text).toMatch(/quote #\d+ wasn’t approved/);
    await approveQuote(ceo, { id: qid });
    expect(await previewApprovalFlag(t, null, g)).toBeNull();
    expect((await previewApprovalFlag({ ...t, buyerStateId: 40099 }, null, g))?.text).toMatch(/wasn’t made from a quote/);
    expect(await previewApprovalFlag({ ...t, buyerStateId: 40099, officerStaffId: ceo.staffId }, null, g)).toBeNull();
  });
});
