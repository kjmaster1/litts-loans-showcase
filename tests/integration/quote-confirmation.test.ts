import { and, eq, inArray, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/request", () => ({ getRequestMeta: async () => ({ ip: "203.0.113.10", userAgent: "vitest" }) }));

/** Quote statuses: draft, confirmed, matched, cancelled (research/19 §1). */

const { saveQuote, cancelQuote, confirmQuote, unconfirmQuote, markQuoteSigned, linkQuote, unlinkQuote, matchQuotes } = await import("@/server/origination/mortgage-quotes");
const { addQuoteNote } = await import("@/server/origination/quote-review");
const { db } = await import("@/server/db");
const { allowanceReading, appSetting, auditEvent, bankTransaction, mortgage, mortgagePayment, mortgageQuote, staff } = await import("@/server/db/schema");
const { getAllowanceOutlook, previewConfirm } = await import("@/server/mortgages/allowance-outlook");
const { allowanceLeft } = await import("@/server/mortgages/allowance");
const { resetDb } = await import("../support/db");
const { ForbiddenError } = await import("@/lib/permissions");

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type Viewer = import("@/server/authz/viewer").Viewer;
let ceo: Viewer;
let manager: Viewer;
let officer: Viewer;
let other: Viewer;

async function makeViewer(stateId: number, name: string, role: Viewer["role"]): Promise<Viewer> {
  const [row] = await db.insert(staff).values({ stateId, characterName: name, role, status: "active" }).returning();
  return { staffId: row.id, userId: `u-${stateId}`, sessionId: `s-${stateId}`, role, characterName: name, stateId, username: name, twoFactorEnabled: true, stepUpAt: null, tourCompletedAt: null, tourRole: null };
}

const small = {
  buyerStateId: 40001,
  buyerName: "Avery Lane",
  address: "2 Small Cottage Ln",
  priceDollars: 500_000,
  agencyCommissionDollars: 25_000,
  downPaymentPct: 10,
  termMonths: 12,
  fedRatePct: 3,
  brokerRatePct: 6,
  bankerFeePct: 5,
  primaryResidence: true,
};

const quoteRow = async (id: string) => (await db.select().from(mortgageQuote).where(eq(mortgageQuote.id, id)))[0];

const auditFor = (action: string, targetId: string) =>
  db.select().from(auditEvent).where(and(eq(auditEvent.action, action), eq(auditEvent.targetId, targetId))).orderBy(auditEvent.id);

beforeAll(async () => {
  await resetDb();
  ceo = await makeViewer(3454, "Kieran Jones", "ceo");
  manager = await makeViewer(70010, "Zion Pemberton", "management");
  officer = await makeViewer(70011, "Skyler Marlowe", "loan_officer");
  other = await makeViewer(70012, "Una Reed", "loan_officer");
});

describe("quote statuses", () => {
  it("a new quote is a draft, and the review/cancel paths accept drafts", async () => {
    const id = await saveQuote(officer, small);
    expect(await quoteRow(id)).toMatchObject({ status: "draft", expectedSigningAt: null, confirmedAt: null, signedAt: null });
    await addQuoteNote(manager, { quoteId: id, text: "Lower the broker rate" });
    await cancelQuote(officer, { id, reason: "Buyer walked" });
    expect(await quoteRow(id)).toMatchObject({ status: "cancelled" });
  });

  it("the officer or management confirms with a signing time; a colleague can't", async () => {
    const id = await saveQuote(officer, small);
    const at = new Date(Date.now() + 2 * DAY);
    await expect(confirmQuote(other, { id, expectedSigningAt: at })).rejects.toThrow(ForbiddenError);
    await expect(confirmQuote(officer, { id, expectedSigningAt: new Date(Date.now() - HOUR) })).rejects.toThrow("The signing time can’t be in the past.");
    await confirmQuote(officer, { id, expectedSigningAt: at });
    expect(await quoteRow(id)).toMatchObject({ status: "confirmed", expectedSigningAt: at, confirmedByStaffId: officer.staffId });
    expect(await auditFor("mortgages.quote.confirmed", id)).toHaveLength(1);
    await expect(confirmQuote(officer, { id, expectedSigningAt: at })).rejects.toThrow("Only a draft can be confirmed.");
  });

  it("changing the figures sends a confirmed quote back to draft; moving the signing time or notes doesn't", async () => {
    const id = await saveQuote(officer, small);
    await confirmQuote(officer, { id, expectedSigningAt: new Date(Date.now() + 2 * DAY) });
    const before = (await quoteRow(id)).expectedSigningAt!;
    const moved = new Date(Date.now() + 3 * DAY);
    await saveQuote(officer, { ...small, notes: "Bids extended", expectedSigningAt: moved }, id);
    expect((await quoteRow(id)).status).toBe("confirmed");
    expect((await auditFor("mortgages.quote.updated", id)).at(-1)?.metadata).toMatchObject({
      expectedSigningAt: { from: before.toISOString(), to: moved.toISOString() },
    });
    // Leaving the signing time out keeps it; clearing it on a confirmed quote is refused.
    const kept = (await quoteRow(id)).expectedSigningAt;
    await saveQuote(officer, { ...small, notes: "Again" }, id);
    expect((await quoteRow(id)).expectedSigningAt).toEqual(kept);
    await expect(saveQuote(officer, { ...small, expectedSigningAt: null }, id)).rejects.toThrow("A confirmed quote needs its signing time.");
    await saveQuote(officer, { ...small, priceDollars: 520_000 }, id);
    expect(await quoteRow(id)).toMatchObject({ status: "draft", confirmedAt: null });
    expect((await auditFor("mortgages.quote.updated", id)).at(-1)?.metadata).toMatchObject({ confirmation: "cleared" });
  });

  it("a quote marked signed in game stays confirmed and signed when its figures change", async () => {
    const id = await saveQuote(officer, small);
    await confirmQuote(officer, { id, expectedSigningAt: new Date(Date.now() + 60_000) });
    await expect(markQuoteSigned(manager, { id, signedAt: new Date(Date.now() + HOUR) })).rejects.toThrow("That time is in the future.");
    await markQuoteSigned(manager, { id, signedAt: new Date() });
    expect(await auditFor("mortgages.quote.signed", id)).toHaveLength(1);
    await saveQuote(officer, { ...small, priceDollars: 510_000 }, id);
    expect(await quoteRow(id)).toMatchObject({ status: "confirmed", signedByStaffId: manager.staffId });
    await unconfirmQuote(officer, { id });
    expect(await quoteRow(id)).toMatchObject({ status: "draft", signedAt: null, confirmedAt: null });
    expect(await auditFor("mortgages.quote.unconfirmed", id)).toHaveLength(1);
    await expect(unconfirmQuote(officer, { id })).rejects.toThrow("Only a confirmed quote can go back to draft.");
    await expect(markQuoteSigned(officer, { id, signedAt: new Date() })).rejects.toThrow("Only a confirmed quote can be marked signed.");
  });

  const insertMortgage = async (address: string, originatedAt: Date) => {
    const [m] = await db
      .insert(mortgage)
      .values({ address, buyerStateId: small.buyerStateId, buyerName: small.buyerName, downPaymentCents: 5_000_000, brokerFeeCents: 100, agencyCommissionCents: 2_500_000, loanCents: 45_000_000, originatedAt, lastTabletAt: new Date() })
      .returning();
    return m;
  };

  it("unlinking a matched quote returns it to draft", async () => {
    const id = await saveQuote(officer, { ...small, address: "3 Unlink Ln" });
    await confirmQuote(officer, { id, expectedSigningAt: new Date(Date.now() + DAY) });
    const m = await insertMortgage("3 Unlink Ln", new Date());
    await linkQuote(officer, { id, mortgageId: m.id, reason: "Same buyer and address" });
    expect((await quoteRow(id)).status).toBe("matched");
    await unlinkQuote(officer, { id, reason: "Wrong mortgage" });
    expect(await quoteRow(id)).toMatchObject({ status: "draft", mortgageId: null, confirmedAt: null, signedAt: null });
  });

  it("matches a quote whose signing is more than 30 days after it was made", async () => {
    const id = await saveQuote(officer, { ...small, address: "4 Late Signing Ln" });
    await confirmQuote(officer, { id, expectedSigningAt: new Date(Date.now() + 40 * DAY) });
    const m = await insertMortgage("4 Late Signing Ln", new Date(Date.now() + 39 * DAY));
    await db.transaction((tx) => matchQuotes(tx));
    expect(await quoteRow(id)).toMatchObject({ status: "matched", mortgageId: m.id });
  });
});

describe("allowance outlook loader", () => {
  const now = new Date("2026-10-20T12:00:00Z");
  const readingAt = new Date("2026-10-20T00:00:00Z");

  it("returns null without a live reading", async () => {
    expect(await getAllowanceOutlook(manager, now)).toBeNull();
    expect(await previewConfirm(manager, "00000000-0000-4000-8000-000000000000", new Date(now.getTime() + DAY))).toBeNull();
    expect(await allowanceLeft()).toBeNull();
  });

  async function seedMortgage() {
    await db.update(mortgageQuote).set({ status: "cancelled" }).where(inArray(mortgageQuote.status, ["draft", "confirmed"]));
    await db.insert(allowanceReading).values({ observedAt: readingAt, balanceCents: 100_000_000, createdByStaffId: ceo.staffId });
    await db.insert(appSetting).values({ key: "allowance.rule", value: { ruleId: "o1-principal4", adoptedAt: readingAt.toISOString() }, updatedByStaffId: ceo.staffId });
    const [m] = await db
      .insert(mortgage)
      .values({
        address: "9 Test Row",
        buyerStateId: 40009,
        buyerName: "Test Buyer",
        downPaymentCents: 5_000_000,
        brokerFeeCents: 100,
        agencyCommissionCents: 0,
        loanCents: 40_000_000,
        brokerInterestCents: 400_000,
        federalInterestCents: 800_000,
        instalments: 4,
        officerStaffId: other.staffId,
        originatedAt: new Date("2026-10-10T12:00:00Z"),
        lastTabletAt: new Date(),
      })
      .returning();
    const batchId = crypto.randomUUID();
    await db.execute(sql`insert into import_batch (id, kind, file_name, file_sha256, wallet_id, export_timezone, reported_balance_cents, row_count, new_count, duplicate_count, ruleset_version)
      values (${batchId}, 'bank_xlsx', 'x.xlsx', 'x', '69811362', 'UTC', 0, 1, 1, 0, 1)`);
    const [tx] = await db
      .insert(bankTransaction)
      .values({ batchId, walletId: "69811362", occurredAt: new Date("2026-10-17T12:00:00Z"), direction: "in", txType: "Transfer", amountCents: 10_300_000, comment: "9 Test Row repayment", fingerprint: "qc-outlook-1", occurrence: 1, category: "mortgage.repayment", confidence: "certain", rulesetVersion: 1 })
      .returning();
    await db.insert(mortgagePayment).values({ bankTransactionId: tx.id, mortgageId: m.id });
    return m;
  }

  it("hides other officers' mortgages from an officer but not from management", async () => {
    await seedMortgage();
    const mine = await getAllowanceOutlook(officer, now);
    const repayments = mine!.steps.filter((s) => s.kind === "repayment");
    expect(repayments.length).toBeGreaterThan(0);
    expect(repayments.every((s) => s.label === null)).toBe(true);
    const all = await getAllowanceOutlook(manager, now);
    expect(all!.steps.some((s) => s.label === "9 Test Row")).toBe(true);
    expect(all!.nowCents).toBe(mine!.nowCents);
    expect(all!.ruleSource).toBe("adopted");
  });

  it("confirmed quotes draw on the outlook; drafts don't", async () => {
    const before = (await getAllowanceOutlook(manager, now))!;
    const confirmedId = await saveQuote(officer, { ...small, address: "5 Confirmed Ln" });
    const draftId = await saveQuote(officer, { ...small, address: "6 Draft Ln" });
    await confirmQuote(officer, { id: confirmedId, expectedSigningAt: new Date(Date.now() + 2 * DAY) });
    // Put the signing times around the fixed "now" of this test.
    await db.update(mortgageQuote).set({ expectedSigningAt: new Date(now.getTime() + 2 * DAY) }).where(eq(mortgageQuote.id, confirmedId));
    await db.update(mortgageQuote).set({ expectedSigningAt: new Date(now.getTime() + 3 * DAY) }).where(eq(mortgageQuote.id, draftId));
    const confirmedNo = (await quoteRow(confirmedId)).number;
    const draftNo = (await quoteRow(draftId)).number;

    const o = (await getAllowanceOutlook(officer, now))!;
    expect(o.nowCents).toBe(before.nowCents);
    expect(o.confirmed.map((c) => c.number)).toEqual([confirmedNo]);
    expect(o.drafts.map((d) => d.number)).toEqual([draftNo]);
    expect(o.steps.some((s) => s.kind === "signing" && s.quoteNumber === confirmedNo)).toBe(true);
    expect(o.steps.some((s) => s.quoteNumber === draftNo)).toBe(false);

    const preview = await previewConfirm(manager, draftId, new Date(now.getTime() + 4 * DAY));
    expect(preview!.quote.number).toBe(draftNo);
    expect(preview!.signings.numbers).toEqual([confirmedNo]);
    // A cancelled quote has no preview.
    await cancelQuote(officer, { id: draftId, reason: "Buyer walked" });
    expect(await previewConfirm(manager, draftId, new Date(now.getTime() + 4 * DAY))).toBeNull();
  });

  it("every page shows the same 'now'", async () => {
    const o = (await getAllowanceOutlook(manager, new Date()))!;
    expect((await allowanceLeft())!.balanceCents).toBe(o.nowCents);
  });
});

describe("bell: confirmed quotes", () => {
  const { notificationsFor } = { notificationsFor: (v: Viewer) => import("@/server/notifications").then((m) => m.notificationsFor(v)) };
  const kinds = async (v: Viewer) => (await notificationsFor(v)).map((n) => `${n.kind}:${n.href}`);

  it("asks the officer and management whether a passed signing happened", async () => {
    await db.update(mortgageQuote).set({ status: "cancelled" }).where(inArray(mortgageQuote.status, ["draft", "confirmed"]));
    const id = await saveQuote(officer, { ...small, address: "20 Passed Ln" });
    await confirmQuote(officer, { id, expectedSigningAt: new Date(Date.now() + DAY) });
    const href = `/mortgages/quotes/${id}`;
    expect(await kinds(officer)).not.toContain(`quote_signing_passed:${href}`);
    await db.update(mortgageQuote).set({ expectedSigningAt: new Date(Date.now() - 3 * HOUR) }).where(eq(mortgageQuote.id, id));
    expect(await kinds(officer)).toContain(`quote_signing_passed:${href}`);
    expect(await kinds(manager)).toContain(`quote_signing_passed:${href}`);
    expect(await kinds(other)).not.toContain(`quote_signing_passed:${href}`);
    await markQuoteSigned(officer, { id, signedAt: new Date(Date.now() - 2 * HOUR) });
    expect(await kinds(officer)).not.toContain(`quote_signing_passed:${href}`);
    expect(await kinds(officer)).toContain(`quote_awaiting_tablet:${href}`);
    expect(await kinds(manager)).toContain(`quote_awaiting_tablet:${href}`);
    expect(await kinds(other)).not.toContain(`quote_awaiting_tablet:${href}`);
    const mine = (await notificationsFor(officer)).find((n) => n.kind === "quote_awaiting_tablet")!;
    expect(mine.title).toMatch(/^Paste the tablet agreement for quote #\d+$/);
  });

  it("refuses a signed time before the quote was made, and marking a signed quote again", async () => {
    const id = await saveQuote(officer, { ...small, address: "21 Early Ln" });
    await confirmQuote(officer, { id, expectedSigningAt: new Date(Date.now() + DAY) });
    await expect(markQuoteSigned(officer, { id, signedAt: new Date(Date.now() - 3 * DAY) })).rejects.toThrow("That’s before the quote was made.");
    await markQuoteSigned(officer, { id, signedAt: new Date(Date.now() - HOUR) });
    await expect(markQuoteSigned(officer, { id, signedAt: new Date(Date.now() - HOUR) })).rejects.toThrow("It’s already marked signed. Move it back to draft to change that.");
  });

  it("tells an officer when a colleague's confirmation left their quote short", async () => {
    await db.update(mortgageQuote).set({ status: "cancelled" }).where(inArray(mortgageQuote.status, ["draft", "confirmed"]));
    // The earlier seeded mortgage has fixed dates: an instalment of it falling due before these signings tops the allowance up.
    await db.update(mortgage).set({ status: "completed" }).where(eq(mortgage.status, "active"));
    await db.insert(allowanceReading).values({ observedAt: new Date(), balanceCents: 100_000_000, createdByStaffId: ceo.staffId });
    const a = await saveQuote(officer, { ...small, address: "21 First Ln", priceDollars: 900_000, agencyCommissionDollars: 0 });
    await confirmQuote(officer, { id: a, expectedSigningAt: new Date(Date.now() + 3 * DAY) });
    expect(await kinds(officer)).not.toContain(`quote_pushed_short:/mortgages/quotes/${a}`);
    const b = await saveQuote(other, { ...small, address: "22 Second Ln", priceDollars: 600_000, agencyCommissionDollars: 0 });
    await confirmQuote(other, { id: b, expectedSigningAt: new Date(Date.now() + 2 * DAY) });
    const items = await notificationsFor(officer);
    const hit = items.find((n) => n.kind === "quote_pushed_short");
    expect(hit?.href).toBe(`/mortgages/quotes/${a}`);
    expect(hit?.title).toMatch(/no longer fits the allowance$/);
    expect(hit?.detail).toContain("Una Reed");
    expect(await kinds(other)).not.toContain(`quote_pushed_short:/mortgages/quotes/${b}`);
  });
});
