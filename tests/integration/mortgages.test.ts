import { readFileSync } from "node:fs";
import { count, eq, sql } from "drizzle-orm";
import * as XLSX from "xlsx";
import { beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";

vi.mock("@/server/request", () => ({ getRequestMeta: async () => ({ ip: "203.0.113.10", userAgent: "vitest" }) }));

const { commitImport, cashBalanceCents, stageImport } = await import("@/server/bank/import");
const { syncMortgages } = await import("@/server/mortgages/sync");
const { commitTablet, previewTablet } = await import("@/server/mortgages/tablet");
const { getMortgage, listMortgages, mortgageKpis } = await import("@/server/mortgages/queries");
const { addReading, adoptRule, getAllowanceView, voidReading } = await import("@/server/mortgages/allowance");
const { assignMortgageOfficer } = await import("@/server/mortgages/service");
const { db } = await import("@/server/db");
const { allowanceReading, auditEvent, mortgage, mortgagePayment, staff } = await import("@/server/db/schema");
const { resetDb } = await import("../support/db");

type Viewer = import("@/server/authz/viewer").Viewer;
const SAMPLE = readFileSync("tests/fixtures/paste-mortgage.txt", "utf8");
let ceo: Viewer;
let officer: Viewer;

async function makeViewer(stateId: number, name: string, role: Viewer["role"]): Promise<Viewer> {
  const [row] = await db.insert(staff).values({ stateId, characterName: name, role, status: "active" }).returning();
  return { staffId: row.id, userId: `u-${stateId}`, sessionId: `s-${stateId}`, role, characterName: name, stateId, username: name, twoFactorEnabled: true, stepUpAt: null, tourCompletedAt: null, tourRole: null };
}

beforeAll(async () => {
  await resetDb();
  ceo = await makeViewer(424242, "Mortgage Tester", "ceo");
  // The tablet sample's finance officer is #3628.
  officer = await makeViewer(3628, "Skyler Marlowe", "loan_officer");
  const stagingId = await stageImport(ceo, { name: "export.xlsx", bytes: readFileSync("tests/fixtures/bank-export.xlsx") });
  await commitImport(ceo, stagingId);
});

describe("mortgage sync after a bank import", () => {
  it("creates a mortgage for every origination and links repayments", async () => {
    const [{ n }] = await db.select({ n: count() }).from(mortgage);
    expect(n).toBe(27);
    const [{ p }] = await db.select({ p: count() }).from(mortgagePayment);
    // All 15 repayments: #12197's was under 112 West Mirror Drive, her house renumbered from 119 (linked by who paid).
    expect(p).toBe(15);
    const k = await mortgageKpis(ceo);
    expect(k.unpasted).toBe(27);
    expect(k.unlinkedRepayments).toBe(0);
    const [moved] = await db.select().from(mortgage).where(eq(mortgage.buyerStateId, 12197));
    expect(moved).toMatchObject({ address: "112 West Mirror Drive", addressAliases: ["119 West Mirror Drive"] });
  });

  it("is idempotent", async () => {
    expect(await syncMortgages()).toMatchObject({ created: 0, adopted: 0, paymentsLinked: 0, completed: 0 });
  });
});

describe("tablet paste", () => {
  it("previews the 117 Invention Ct agreement against its bank origination", async () => {
    const { items } = await previewTablet(ceo, { text: SAMPLE });
    expect(items).toHaveLength(1);
    expect(items[0].match).toMatchObject({ kind: "matched", how: "address, buyer and amounts", firstPaste: true });
    expect(items[0].officer).toMatchObject({ stateId: 3628, staffId: officer.staffId });
    expect(items[0].guidelines).toEqual([]);
  });

  it("sets terms, parties and officer, and builds the schedule", async () => {
    const result = await commitTablet(ceo, { text: SAMPLE });
    expect(result).toMatchObject({ updated: 1, created: 0, ignored: 0 });
    const [row] = await listMortgages(ceo, { q: "117 Invention" });
    expect(row).toMatchObject({ pasted: true, instalments: 52, officerName: "Skyler Marlowe", loanCents: 62_044_700 });
    const detail = (await getMortgage(ceo, row.id))!;
    expect(detail.analysis?.schedule).toHaveLength(52);
    expect(detail.origination).toMatchObject({ inCents: 20_303_000, outCents: 11_340_900 });
    expect(detail.events.map((e) => e.kind)).toContain("terms_set");
    // The officer now sees it; cash is untouched by pasting.
    expect((await listMortgages(officer, { status: "all" })).map((m) => m.id)).toEqual([row.id]);
    expect(await cashBalanceCents()).toBe(18_533_100);
  });

  it("records a re-paste without duplicating", async () => {
    expect(await commitTablet(ceo, { text: SAMPLE })).toMatchObject({ updated: 1, created: 0 });
    const [{ n }] = await db.select({ n: count() }).from(mortgage);
    expect(n).toBe(27);
  });

  it("creates a tablet-only mortgage for an agreement not yet in the bank, leaving another buyer's repayments alone", async () => {
    // 112 West Mirror Drive is #12197's house now; this agreement is #1632's (the server reuses numbers).
    const text = SAMPLE.replace("117 Invention Ct", "112 West Mirror Drive");
    const { items } = await previewTablet(ceo, { text });
    // Same buyer and price as 117 Invention Ct: someone has to say it's another property.
    expect(items[0].match.kind).toBe("possible_duplicate");
    await commitTablet(ceo, { text, decisions: { "0": "new" } });
    const onAddress = await db.select().from(mortgage).where(eq(mortgage.address, "112 West Mirror Drive"));
    const paid = async (id: string) => (await db.select({ p: count() }).from(mortgagePayment).where(eq(mortgagePayment.mortgageId, id)))[0].p;
    const created = onAddress.find((m) => m.buyerStateId === 1632)!;
    const theirs = onAddress.find((m) => m.buyerStateId === 12197)!;
    expect(created.originationTxId).toBeNull();
    expect(await paid(created.id)).toBe(0);
    expect(await paid(theirs.id)).toBe(1);
    expect((await mortgageKpis(ceo)).unlinkedRepayments).toBe(0);
  });

  it("refuses text with no agreement", async () => {
    await expect(previewTablet(ceo, { text: "hello" })).rejects.toThrow(/No sale agreement/);
  });
});

describe("quotes made in the app", () => {
  it("are matched to the mortgage once the sale agreement is in (same buyer, same loan)", async () => {
    const { mortgageQuote } = await import("@/server/db/schema");
    const [m] = await db.select().from(mortgage).where(eq(mortgage.address, "117 Invention Ct"));
    // The officer's quote, made an hour before the sale (inserted directly: quotes are dated now).
    const [q] = await db
      .insert(mortgageQuote)
      .values({
        buyerStateId: m.buyerStateId!,
        buyerName: m.buyerName ?? "Buyer",
        officerStaffId: officer.staffId,
        address: "117 Invention Court (typo)",
        priceCents: m.priceCents!,
        agencyCommissionCents: m.agencyCommissionCents!,
        downPaymentBp: 1000,
        termMonths: 12,
        fedRateBp: 300,
        brokerRateBp: 600,
        bankerFeeBp: 800,
        primaryResidence: true,
        createdByStaffId: officer.staffId,
        createdAt: new Date(m.originatedAt!.getTime() - 3_600_000),
      })
      .returning();
    await syncMortgages();
    const [after] = await db.select().from(mortgageQuote).where(eq(mortgageQuote.id, q.id));
    expect(after).toMatchObject({ status: "matched", mortgageId: m.id });

    // Unlinked by hand ("not this mortgage"): back to open, and never matched to it again.
    const { linkQuote, mortgageCandidates, unlinkQuote } = await import("@/server/origination/mortgage-quotes");
    await unlinkQuote(officer, { id: q.id, reason: "Wrong property for this buyer" });
    await syncMortgages();
    const [open] = await db.select().from(mortgageQuote).where(eq(mortgageQuote.id, q.id));
    expect(open).toMatchObject({ status: "draft", mortgageId: null, excludedMortgageIds: [m.id] });
    expect((await mortgageCandidates(officer, q.id)).map((c) => c.id)).toContain(m.id);
    await linkQuote(officer, { id: q.id, mortgageId: m.id, reason: "It was this one after all" });
    const [relinked] = await db.select().from(mortgageQuote).where(eq(mortgageQuote.id, q.id));
    expect(relinked).toMatchObject({ status: "matched", mortgageId: m.id, excludedMortgageIds: [] });
  });

  it("leaves nothing for the pages to catch up on (they no longer sync on load)", async () => {
    const { mortgageSyncPending } = await import("@/server/mortgages/sync");
    expect(await mortgageSyncPending()).toBe(false);
  });
});

describe("addresses renumbered by the server", () => {
  /** An agreement for 105 South Rockford Dr's buyer and money, under a new address. */
  const renumbered = SAMPLE.replace("117 Invention Ct", "999 Renumbered Rd")
    .replace("#1632 Jordan Ironside", "#27101 Tobin Hartwell")
    .replace(/Down payment(\r?\n)\$68,939/, "Down payment$1$$100,000")
    .replace(/Broker fee(\r?\n)\$55,151/, "Broker fee$1$$54,966")
    .replace(/Agency commission(\r?\n)\$44,470/, "Agency commission$1$$74,896");

  it("matches the existing mortgage by buyer and exact money, and keeps the old address", async () => {
    const { items } = await previewTablet(ceo, { text: renumbered });
    expect(items[0].match).toMatchObject({ kind: "matched", how: "buyer and amounts (the address has changed)" });
    expect(items[0].match.kind === "matched" && items[0].match.changes[0]).toMatch(/address \(was 105 South Rockford Dr\)/);
    await commitTablet(ceo, { text: renumbered });
    const [m] = await db.select().from(mortgage).where(eq(mortgage.address, "999 Renumbered Rd"));
    expect(m.addressAliases).toEqual(["105 South Rockford Dr"]);
    expect(m.originationTxId).not.toBeNull();
    const [{ p }] = await db.select({ p: count() }).from(mortgagePayment).where(eq(mortgagePayment.mortgageId, m.id));
    expect(p).toBe(1);
  });

  it("merges a duplicate created before this was understood", async () => {
    // 110 Ineseno Road (buyer 25602): net in $333,178, to the State $203,907.
    const [bank] = await db.select().from(mortgage).where(eq(mortgage.address, "110 Ineseno Road"));
    const [dupe] = await db
      .insert(mortgage)
      .values({
        address: "111 Ineseno Road",
        buyerStateId: 25602,
        buyerName: "Kai Crestwood",
        downPaymentCents: 10_000_000,
        brokerFeeCents: 12_927_100,
        agencyCommissionCents: 10_390_700,
        loanCents: 50_000_000,
        lastTabletAt: new Date(),
      })
      .returning();
    const result = await syncMortgages();
    expect(result.merged).toBe(1);
    const [after] = await db.select().from(mortgage).where(eq(mortgage.id, dupe.id));
    expect(after).toMatchObject({ originationTxId: bank.originationTxId, addressAliases: ["110 Ineseno Road"] });
    const [retired] = await db.select().from(mortgage).where(eq(mortgage.id, bank.id));
    expect(retired).toMatchObject({ mergedIntoId: dupe.id, originationTxId: null });
    const [{ p }] = await db.select({ p: count() }).from(mortgagePayment).where(eq(mortgagePayment.mortgageId, dupe.id));
    expect(p).toBe(1);
    const all = await listMortgages(ceo, { status: "all" });
    expect(all.some((m) => m.id === bank.id)).toBe(false);
    expect(await getMortgage(ceo, bank.id)).toBeNull();
    expect(await syncMortgages()).toMatchObject({ merged: 0, paymentsLinked: 0 });
  });
});

describe("company-funded mortgages (103 Forum Dr, Apt 2I)", () => {
  const balanceOf = async (code: string) =>
    Number((await db.execute(sql`select coalesce(sum(debit_cents - credit_cents), 0) as b from journal_line where account_code = ${code}`)).rows[0].b);
  const forumIncome = async () =>
    Number(
      (
        await db.execute(sql`select coalesce(sum(l.credit_cents - l.debit_cents), 0) as b from journal_line l join journal_entry e on e.id = l.entry_id
          where l.account_code = '4100' and (l.memo like '%103 Forum Dr, Apt 2I%' or e.description like '%103 Forum Dr, Apt 2I%')`)
      ).rows[0].b,
    );

  it("books the banker fee and a receivable instead of a negative fee", async () => {
    const text = readFileSync("tests/fixtures/paste-mortgage-company.txt", "utf8");
    const { items } = await previewTablet(ceo, { text });
    expect(items[0]).toMatchObject({ funding: "company", match: { kind: "matched", how: "address, buyer and amounts" } });
    expect(await forumIncome()).toBe(-791_000); // the pairing alone: $28,886 in − $36,796 out
    await commitTablet(ceo, { text });

    const [m] = await db.select().from(mortgage).where(eq(mortgage.address, "103 Forum Dr, Apt 2I"));
    expect(m).toMatchObject({ funding: "company" });
    expect(m.fundingEntryId).not.toBeNull();
    expect(await forumIncome()).toBe(184_000); // the real banker fee
    expect(await balanceOf("1120")).toBe(975_000); // the buyer owes Litt's the loan
    expect(await cashBalanceCents()).toBe(18_533_100);
    const detail = (await getMortgage(ceo, m.id))!;
    expect(detail.analysis?.schedule[0]).toMatchObject({ principalCents: 75_000, brokerInterestCents: 5_600, federalInterestCents: 0 });
    const k = await mortgageKpis(ceo);
    expect(k.owedToCompanyCents).toBe(975_000);
    expect(await syncMortgages()).toMatchObject({ fundingEntries: 0 });
  });

  it("splits a repayment into principal back to Litt's and interest", async () => {
    // A $806 weekly repayment arrives in a later bank export.
    const wb = XLSX.read(readFileSync("tests/fixtures/bank-export.xlsx"), { type: "buffer" });
    const grid = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, blankrows: true, defval: null });
    const template = grid.slice(6).find((r) => typeof r[8] === "string" && (r[8] as string).endsWith(": Loan Repayment") && r[5] === "69811362")!;
    const row = [...template];
    row[2] = 806;
    row[6] = "Finley Tremaine";
    row[7] = 27588;
    row[8] = "103 Forum Dr, Apt 2I: Loan Repayment";
    row[9] = 0;
    row[10] = 0;
    const out = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(out, XLSX.utils.aoa_to_sheet([...grid.slice(0, 6), row]), wb.SheetNames[0]);
    const before1120 = await balanceOf("1120");
    const before4110 = await balanceOf("4110");
    const stagingId = await stageImport(ceo, { name: "repayment.xlsx", bytes: XLSX.write(out, { type: "buffer", bookType: "xlsx" }) });
    await commitImport(ceo, stagingId);

    expect(await balanceOf("1120")).toBe(before1120 - 75_000);
    expect(await balanceOf("4110")).toBe(before4110 - 5_600); // credit-natural: more income
    const [m] = await db.select().from(mortgage).where(eq(mortgage.address, "103 Forum Dr, Apt 2I"));
    // The payment was taken back out of clearing by its own entry (nothing goes to the State).
    const [link] = await db.select().from(mortgagePayment).where(eq(mortgagePayment.mortgageId, m.id));
    expect(link.entryId).not.toBeNull();
    expect(await syncMortgages()).toMatchObject({ repaymentEntries: 0 });
    const detail = (await getMortgage(ceo, m.id))!;
    expect(detail.analysis?.paidCount).toBe(1);
    const tb = await db.execute(sql`select sum(debit_cents) = sum(credit_cents) as ok from journal_line`);
    expect(tb.rows[0].ok).toBe(true);
  });
});

describe("officers", () => {
  it("only Management+ reassign; officers may claim unassigned mortgages", async () => {
    const [unassigned] = (await listMortgages(ceo, { status: "all" })).filter((m) => !m.officerName);
    await assignMortgageOfficer(officer, { mortgageId: unassigned.id, officerStaffId: officer.staffId });
    await expect(assignMortgageOfficer(officer, { mortgageId: unassigned.id, officerStaffId: null })).rejects.toThrow(/only claim/);
    await expect(assignMortgageOfficer(ceo, { mortgageId: unassigned.id, officerStaffId: ceo.staffId })).rejects.toThrow(/reason/);
  });
});

describe("collections on late mortgages", () => {
  it("queues mortgages behind on payments, logs actions on them and spots broken promises", async () => {
    // The fixture's mortgages are only days old: look from five weeks on, when they've fallen behind.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 35 * 86_400_000));
    onTestFinished(() => void vi.useRealTimers());
    const { collectionsQueue, logCollection, mortgageCollections } = await import("@/server/loans/collections");
    const behind = (await collectionsQueue(ceo)).filter((r) => r.type === "mortgage");
    expect(behind.length).toBeGreaterThan(0);
    const target = behind[0];
    expect(target).toMatchObject({ status: "behind", due: true, last: null, href: `/mortgages/${target.id}` });
    expect(target.missed).toBeGreaterThan(0);

    // Only Legal+ or the mortgage's own officer.
    const [m] = await db.select().from(mortgage).where(eq(mortgage.id, target.id));
    if (m.officerStaffId !== officer.staffId) {
      await expect(logCollection(officer, { mortgageId: target.id, kind: "contacted", note: "Rang them" })).rejects.toThrow(/officer, Legal or management/);
    }
    await expect(logCollection(ceo, { mortgageId: target.id, loanId: target.id, kind: "note", note: "Both" })).rejects.toThrow(/loan or a mortgage/);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
    await logCollection(ceo, { mortgageId: target.id, kind: "promise", note: "Will pay today", promiseDollars: 100_000, promiseBy: today });

    const [entry] = (await mortgageCollections([target.id])).get(target.id)!;
    expect(entry.outcome?.state).toBe("pending");
    const later = new Date(Date.now() + 2 * 86_400_000);
    const [after] = (await mortgageCollections([target.id], later)).get(target.id)!;
    expect(after.outcome).toEqual({ state: "broken", paidCents: 0 });
    const row = (await collectionsQueue(ceo, later)).find((r) => r.id === target.id)!;
    expect(row).toMatchObject({ brokenPromises: 1, due: true });

    const audits = await db.select().from(auditEvent).where(eq(auditEvent.action, "mortgages.collection.logged"));
    expect(audits).toHaveLength(1);

    // The bell: shows the broken promise once the day has passed; reading it only stops it counting as new.
    vi.setSystemTime(later);
    const { notificationsFor, markNotificationsRead } = await import("@/server/notifications");
    const bell = await notificationsFor(ceo);
    const n = bell.find((x) => x.key === `broken:${entry.id}`)!;
    expect(n).toMatchObject({ kind: "broken_promise", href: `/mortgages/${target.id}`, read: false });
    await markNotificationsRead(ceo, { keys: [n.key] });
    await markNotificationsRead(ceo, { keys: [n.key] }); // twice is fine
    expect((await notificationsFor(ceo)).find((x) => x.key === n.key)?.read).toBe(true);
    // Read state is per person: the officer doesn't see someone else's case at all.
    expect((await notificationsFor(officer)).some((x) => x.key === n.key)).toBe(m.officerStaffId === officer.staffId);

    // The borrower's profile shows the mortgage and the logged promise.
    const { borrowerProfile } = await import("@/server/borrowers");
    if (m.buyerStateId) {
      const p = await borrowerProfile(ceo, m.buyerStateId);
      expect(p.mortgages.map((x) => x.id)).toContain(target.id);
      expect(p.activity.some((a) => a.kind === "collection" && a.entry.id === entry.id)).toBe(true);
      expect(p.totals.netCents).not.toBeNull();
      const asOfficer = await borrowerProfile(officer, m.buyerStateId);
      expect(asOfficer.totals.netCents).toBeNull(); // profit is for finance viewers
    }
  });
});

describe("State allowance", () => {
  it("records readings, refuses officers, and voids instead of deleting", async () => {
    await expect(addReading(officer, { balanceDollars: 1, observedAt: new Date() })).rejects.toThrow(/permission/);
    await addReading(ceo, { balanceDollars: 796_196, observedAt: new Date("2026-10-07T23:00:00Z"), note: "Phone, before 117 Invention Ct" });
    await addReading(ceo, { balanceDollars: 1, observedAt: new Date("2026-10-07T23:30:00Z") });
    await expect(addReading(ceo, { balanceDollars: 1, observedAt: new Date("2026-10-07T23:30:00Z") })).rejects.toThrow(/already recorded/);
    const [wrong] = await db.select().from(allowanceReading).where(eq(allowanceReading.balanceCents, 100));
    await voidReading(ceo, { id: wrong.id, reason: "Typo — missed digits" });
    await expect(voidReading(ceo, { id: wrong.id, reason: "again please" })).rejects.toThrow(/already voided/);
    await expect(db.execute(sql`delete from allowance_reading`)).rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringMatching(/append-only/) }) });
    const [event] = await db.select().from(auditEvent).where(eq(auditEvent.action, "allowance.reading.voided"));
    expect(event.reason).toBe("Typo — missed digits");
  });

  it("scores the candidate rules against readings either side of an origination", async () => {
    // Simulate the truth "−1× loan when a mortgage starts": 117 Invention Ct's loan is $620,447.
    await addReading(ceo, { balanceDollars: 796_196 - 620_447, observedAt: new Date("2026-10-08T01:00:00Z") });
    const view = await getAllowanceView();
    const informative = view.fit.intervals.filter((iv) => iv.events.length > 0);
    expect(informative).toHaveLength(1);
    expect(view.fit.ranking[0].rule.originationMultiple).toBe(1);
    expect(view.gaps.mortgagesWithoutTerms).toBeGreaterThan(0);
  });

  it("projects from an adopted rule", async () => {
    await adoptRule(ceo, { ruleId: "o1-principal4", reason: "Matches the readings so far" });
    const view = await getAllowanceView();
    expect(view.adopted?.rule.id).toBe("o1-principal4");
    expect(view.projection?.source).toBe("adopted");
  });
});

describe("federal maximums (owner, 2026-10-15)", () => {
  it("flag a State mortgage arranged since then, and tell the executives", async () => {
    // $50,000 + $450,000 = $500,000: the first band (10% fee, 10% broker) — a $60,000 fee is over it.
    const [m] = await db
      .insert(mortgage)
      .values({
        address: "200 Federal Way",
        originatedAt: new Date("2026-10-16T12:00:00Z"),
        funding: "state",
        downPaymentCents: 5_000_000,
        loanCents: 45_000_000,
        brokerFeeCents: 6_000_000,
        brokerRateBp: 1000,
        fedRateBp: 300,
        officerName: "Skyler Marlowe",
      })
      .returning();
    const detail = (await getMortgage(ceo, m.id))!;
    expect(detail.flags).toEqual([
      {
        level: "breach",
        rule: "federal_maximum",
        text: "Banker fee $60,000 (12%) is above the federal maximum of 10% ($50,000) for mortgages up to $500,000",
      },
    ]);
    const { notificationsFor } = await import("@/server/notifications");
    expect((await notificationsFor(ceo)).find((n) => n.kind === "federal_breach")).toMatchObject({
      title: "200 Federal Way is over the federal maximums",
      href: `/mortgages/${m.id}`,
    });
    expect((await notificationsFor(officer)).some((n) => n.kind === "federal_breach")).toBe(false);
    // Company-funded: exempt.
    await db.update(mortgage).set({ funding: "company", fedRateBp: null }).where(eq(mortgage.id, m.id));
    expect((await getMortgage(ceo, m.id))!.flags).toEqual([]);
    expect((await notificationsFor(ceo)).some((n) => n.kind === "federal_breach")).toBe(false);
  });
});
