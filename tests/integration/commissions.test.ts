import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import * as XLSX from "xlsx";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/request", () => ({ getRequestMeta: async () => ({ ip: "203.0.113.10", userAgent: "vitest" }) }));

const { commitImport, cashBalanceCents, stageImport } = await import("@/server/bank/import");
const { assignPayout, closeWeek, getWeek, saveRoster, syncPayouts } = await import("@/server/commissions/service");
const { balances, myCommission, payouts } = await import("@/server/commissions/queries");
const { assignMortgageOfficer } = await import("@/server/mortgages/service");
const { applyOfficerSuggestions, linkWallet, officerSuggestions } = await import("@/server/commissions/officers");
const { db } = await import("@/server/db");
const { loan, mortgage, staff } = await import("@/server/db/schema");
const { resetDb } = await import("../support/db");

type Viewer = import("@/server/authz/viewer").Viewer;
const WEEK = "2026-10-12";
/** Excel serial days in the export's clock (UTC, whatever its header says: ADR 0004). */
const serial = (iso: string) => Date.parse(iso) / 86_400_000 + 25569;
const DURING = new Date("2026-10-14T12:00:00Z");
const AFTER = new Date("2026-10-20T12:00:00Z");

let ceo: Viewer;
let jax: Viewer;
let skyler: Viewer;

async function makeViewer(stateId: number, name: string, role: Viewer["role"]): Promise<Viewer> {
  const [row] = await db.insert(staff).values({ stateId, characterName: name, role, status: "active" }).returning();
  return { staffId: row.id, userId: `u-${stateId}`, sessionId: `s-${stateId}`, role, characterName: name, stateId, username: name, twoFactorEnabled: true, stepUpAt: null, tourCompletedAt: null, tourRole: null };
}

/** An export holding the fixture's header and the given rows. */
function exportWith(rows: unknown[][]) {
  const wb = XLSX.read(readFileSync("tests/fixtures/bank-export.xlsx"), { type: "buffer" });
  const grid = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, blankrows: true, defval: null });
  const out = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(out, XLSX.utils.aoa_to_sheet([...grid.slice(0, 6), ...rows]), wb.SheetNames[0]);
  return XLSX.write(out, { type: "buffer", bookType: "xlsx" }) as Uint8Array;
}

async function importRows(rows: unknown[][], name: string) {
  const stagingId = await stageImport(ceo, { name, bytes: exportWith(rows) });
  await commitImport(ceo, stagingId);
}

const balanceOf = async (code: string) =>
  Number((await db.execute(sql`select coalesce(sum(debit_cents - credit_cents), 0) as b from journal_line where account_code = ${code}`)).rows[0].b);

beforeAll(async () => {
  await resetDb();
  ceo = await makeViewer(424242, "Commission Tester", "ceo");
  jax = await makeViewer(515151, "Jax Chaplan", "loan_officer");
  skyler = await makeViewer(616161, "Skyler Marlowe", "loan_officer");
  await commitImport(ceo, await stageImport(ceo, { name: "export.xlsx", bytes: readFileSync("tests/fixtures/bank-export.xlsx") }));
  // Briar Kestrel's $100,000 loan is Jax's.
  await db.update(loan).set({ officerStaffId: jax.staffId }).where(eq(loan.borrowerStateId, 12416));

  await importRows(
    [
      // Week of 12 Oct: $2,000 broker interest ($58 tax) on Briar's loan, and a new State-funded mortgage.
      [serial("2026-10-13T12:00:00Z"), null, 2000, "transfer", "69530344", "69811362", "Briar Kestrel", 12416, "Broker percentage payment: Loan Agreement Amount: $100000 ID: 5aa31c531970cb5e047d1fbb", 58, 3],
      [serial("2026-10-14T09:00:00Z"), null, 150000, "transfer", "69400001", "69811362", "Rowan Ashcombe", 30001, "777 Commission Way: Down Payment & Fees", 0, 0],
      [serial("2026-10-14T09:00:00Z"), null, 100000, "transfer", "69811362", "69833729", "San Andreas State", 101, "777 Commission Way: Property Loan & Fees", null, null],
      // Paid out the following week.
      [serial("2026-10-19T15:00:00Z"), null, 500, "pay", "69811362", "69000001", "Commission Tester", 424242, "Employee Pay: Commission Pay: week of 12 Oct", null, null],
    ],
    "week-42.xlsx",
  );
});

describe("a commission week", () => {
  it("estimates live while the week is open", async () => {
    const w = await getWeek(WEEK, DURING);
    expect(w).toMatchObject({ status: "open", ended: false });
    const interest = w.calculation.lines.find((l) => l.kind === "loan_interest")!;
    expect(interest).toMatchObject({ staffId: jax.staffId, baseCents: 194_200, amountCents: 97_100 }); // 50% of $2,000 − $58
    // The new mortgage has no officer yet, so it's flagged and can't be paid.
    expect(w.calculation.problems).toEqual([expect.objectContaining({ kind: "no_officer", label: "Banker fee — 777 Commission Way" })]);
  });

  it("can't be locked or closed before it ends, nor closed with problems", async () => {
    await expect(saveRoster(ceo, { weekKey: WEEK, included: [], lock: true }, DURING)).rejects.toThrow(/once the week has ended/);
    await expect(closeWeek(ceo, WEEK, DURING)).rejects.toThrow(/hasn't ended/);
    await expect(saveRoster(jax, { weekKey: WEEK, included: [] }, AFTER)).rejects.toThrow(/permission/);
  });

  it("splits the banker fee 20/30/50 and shares the pool equally", async () => {
    const [m] = await db.select().from(mortgage).where(eq(mortgage.address, "777 Commission Way"));
    await assignMortgageOfficer(ceo, { mortgageId: m.id, officerStaffId: skyler.staffId });
    await saveRoster(ceo, { weekKey: WEEK, included: [jax.staffId, skyler.staffId], lock: true }, AFTER);
    const w = await getWeek(WEEK, AFTER);
    // $50,000 fee: Skyler 20% = $10,000; pool 30% = $15,000 → $7,500 each; company keeps $25,000.
    expect(w.calculation.pool).toMatchObject({ totalCents: 1_500_000, members: 2, perPersonCents: 750_000, remainderCents: 0 });
    expect(w.calculation.totals.get(skyler.staffId)).toBe(1_750_000);
    expect(w.calculation.totals.get(jax.staffId)).toBe(847_100); // $971 + $7,500
    expect(w.calculation.companyShareCents).toBe(2_500_000);
  });

  it("closes: books the accrual and freezes the lines", async () => {
    const cashBefore = await cashBalanceCents();
    expect(await closeWeek(ceo, WEEK, AFTER)).toEqual({ totalCents: 2_597_100 });
    expect(await balanceOf("2000")).toBe(-2_597_100); // credit balance: owed to staff
    expect(await balanceOf("5000")).toBeGreaterThan(0);
    expect(await cashBalanceCents()).toBe(cashBefore);
    const closed = await getWeek(WEEK, AFTER);
    expect(closed.status).toBe("closed");
    await expect(closeWeek(ceo, WEEK, AFTER)).rejects.toThrow(/already closed/);
    await expect(db.execute(sql`delete from commission_line`)).rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringMatching(/immutable|append-only/) }) });
    const [{ n }] = (await db.execute<{ n: number }>(sql`select count(*)::int as n from commission_line`)).rows;
    expect(n).toBeGreaterThanOrEqual(3);
  });
});

describe("payouts", () => {
  it("records commission payouts after the start, unmatched until the wallet is known", async () => {
    const list = await payouts();
    expect(list).toEqual([expect.objectContaining({ amountCents: 50_000, status: "unmatched", targetWallet: "69000001" })]);
    expect(await syncPayouts()).toEqual({ found: 0, matched: 0 });
  });

  it("assigning settles what's owed and remembers the wallet for next time", async () => {
    const owedBefore = await balanceOf("2000");
    const [p] = await payouts();
    await expect(assignPayout(jax, { bankTransactionId: p.txId, to: jax.staffId })).rejects.toThrow(/permission/);
    await assignPayout(ceo, { bankTransactionId: p.txId, to: jax.staffId });
    expect(await balanceOf("2000")).toBe(owedBefore + 50_000);
    const [s] = await db.select().from(staff).where(eq(staff.id, jax.staffId));
    expect(s.walletId).toBe("69000001");
    const b = (await balances()).find((x) => x.staffId === jax.staffId)!;
    expect(b).toMatchObject({ awardedCents: 847_100, paidCents: 50_000, owedCents: 797_100 });

    // The next payout to that wallet matches by itself.
    await importRows([[serial("2026-10-26T15:00:00Z"), null, 300, "pay", "69811362", "69000001", "Commission Tester", 424242, "Employee Pay: Commission Pay: more", null, null]], "week-44.xlsx");
    const latest = (await payouts())[0];
    expect(latest).toMatchObject({ amountCents: 30_000, status: "matched", staffId: jax.staffId, matchedBy: "wallet" });
  });

  it("officers see their own figures", async () => {
    const mine = await myCommission(jax.staffId, AFTER);
    expect(mine.history).toEqual([expect.objectContaining({ key: WEEK, amountCents: 847_100 })]);
    expect(mine.balance?.owedCents).toBe(847_100 - 80_000);
    expect(mine.payouts).toHaveLength(2);
  });
});

describe("the catch-up before the scheme", () => {
  const CATCH_UP = "catch-up";
  const BRIAR_INTEREST = "Broker percentage payment: Loan Agreement Amount: $100000 ID: 5aa31c531970cb5e047d1fbb";
  let other: { id: string; borrowerName: string | null };

  beforeAll(async () => {
    // A loan with no officer whose borrower Skyler was paid for before.
    [other] = await db
      .select({ id: loan.id, borrowerName: loan.borrowerName })
      .from(loan)
      .where(sql`${loan.officerStaffId} is null and ${loan.status} = 'active' and ${loan.borrowerName} is not null`)
      .limit(1);
    await importRows(
      [
        // Two receipts on Briar's loan (Jax's): the first was paid by hand on 27 Sep, the second wasn't.
        [serial("2026-09-20T12:00:00Z"), null, 1000, "transfer", "69530344", "69811362", "Briar Kestrel", 12416, BRIAR_INTEREST, 29, 3],
        [serial("2026-10-01T12:00:00Z"), null, 1000, "transfer", "69530344", "69811362", "Briar Kestrel", 12416, BRIAR_INTEREST, 29, 3],
        [
          serial("2026-09-27T12:30:00Z"),
          null,
          586,
          "pay",
          "69811362",
          "69000002",
          "Commission Tester",
          424242,
          `Employee Pay: Commission Pay: Briar Kestrel  Sep 20, 2026 Â· interest  $486   ${other.borrowerName}  Sep 15, 2026 Â· interest  $100`,
          null,
          null,
        ],
      ],
      "catch-up.xlsx",
    );
  });

  it("pays only the interest no old payment covered, with no pool or banker fees", async () => {
    const w = await getWeek(CATCH_UP, AFTER);
    expect(w).toMatchObject({ catchUp: true, status: "open", ended: true, rosterLocked: true, roster: [] });
    // The fixture's own old payments cover most of its receipts too.
    expect(w.paidBefore.length).toBeGreaterThan(10);
    expect(w.paidBefore.filter((p) => p.label.startsWith("Interest — Briar Kestrel"))).toEqual([
      expect.objectContaining({ label: "Interest — Briar Kestrel · 20 Sep", paidCents: 48_600 }),
    ]);
    const briar = w.calculation.lines.filter((l) => l.label.startsWith("Interest — Briar Kestrel"));
    expect(briar).toEqual(expect.arrayContaining([expect.objectContaining({ label: "Interest — Briar Kestrel · 1 Oct", staffId: jax.staffId, baseCents: 97_100, amountCents: 48_600 })]));
    expect(briar.some((l) => l.label.endsWith("20 Sep"))).toBe(false);
    expect(w.calculation.lines.every((l) => l.kind === "loan_interest")).toBe(true);
    await expect(saveRoster(ceo, { weekKey: CATCH_UP, included: [] }, AFTER)).rejects.toThrow(/no pool roster/);
    await expect(closeWeek(ceo, CATCH_UP, new Date("2026-10-11T12:00:00Z"))).rejects.toThrow(/hasn't ended/);
  });

  it("suggests officers from who was paid before, once the wallet is linked", async () => {
    let s = await officerSuggestions();
    expect(s.wallets).toEqual(expect.arrayContaining([expect.objectContaining({ wallet: "69000002", staffId: null, payouts: 1, borrowers: 2 })]));
    expect(s.suggestions.find((x) => x.loanId === other.id)).toMatchObject({ wallet: "69000002", staffId: null, basis: "borrower" });

    await expect(linkWallet(jax, { wallet: "69000002", staffId: skyler.staffId })).rejects.toThrow(/permission/);
    await expect(linkWallet(ceo, { wallet: "69000001", staffId: skyler.staffId })).rejects.toThrow(/already belongs to Jax/);
    await linkWallet(ceo, { wallet: "69000002", staffId: skyler.staffId });
    s = await officerSuggestions();
    expect(s.suggestions.find((x) => x.loanId === other.id)).toMatchObject({ staffId: skyler.staffId });

    await expect(applyOfficerSuggestions(jax, { loanIds: [other.id] })).rejects.toThrow(/permission/);
    expect(await applyOfficerSuggestions(ceo, { loanIds: [other.id] })).toEqual({ assigned: 1 });
    const [l] = await db.select().from(loan).where(eq(loan.id, other.id));
    expect(l.officerStaffId).toBe(skyler.staffId);
    expect((await officerSuggestions()).suggestions.find((x) => x.loanId === other.id)).toBeUndefined();
  });

  it("closes like a week and shows in the officer's history", async () => {
    // Every other receipt in the period needs an officer before it can close.
    const before = await getWeek(CATCH_UP, AFTER);
    const missing = [...new Set(before.calculation.problems.map((p) => p.loanId!))];
    if (missing.length) await db.update(loan).set({ officerStaffId: jax.staffId }).where(sql`${loan.id} in ${missing}`);
    const w = await getWeek(CATCH_UP, AFTER);
    expect(w.calculation.problems).toEqual([]);
    const total = [...w.calculation.totals.values()].reduce((a, b) => a + b, 0);
    const owedBefore = await balanceOf("2000");
    expect(await closeWeek(ceo, CATCH_UP, AFTER)).toEqual({ totalCents: total });
    expect(await balanceOf("2000")).toBe(owedBefore - total);
    expect((await getWeek(CATCH_UP, AFTER)).status).toBe("closed");
    const mine = await myCommission(jax.staffId, AFTER);
    expect(mine.history).toEqual(expect.arrayContaining([expect.objectContaining({ key: CATCH_UP, label: "Catch-up · 25 Aug – 11 Oct 2026" })]));
  });
});

describe("the pay sheet", () => {
  it("shows one payment per person: total owed, State ID (for Pay Employee), wallet and a comment the import recognises", async () => {
    const { paySheet } = await import("@/server/commissions/queries");
    const before = (await balances()).find((b) => b.staffId === jax.staffId)!;
    const sheet = await paySheet();
    const row = sheet.rows.find((r) => r.staffId === jax.staffId)!;
    expect(row).toMatchObject({ owedCents: before.owedCents, stateId: 515151, wallet: "69000001" });
    expect(row.comment).toMatch(/^\[COMM\] Commission Pay: /);
    expect(row.periods.length).toBeGreaterThan(0);

    // Paying exactly that, with that comment, clears it on the next import.
    await importRows(
      [[serial("2026-10-27T15:00:00Z"), null, row.owedCents / 100, "pay", "69811362", row.wallet, "Commission Tester", 424242, `Employee Pay: ${row.comment}`, null, null]],
      "pay-sheet.xlsx",
    );
    const latest = (await payouts())[0];
    expect(latest).toMatchObject({ amountCents: row.owedCents, status: "matched", staffId: jax.staffId });
    expect((await paySheet()).rows.find((r) => r.staffId === jax.staffId)).toBeUndefined();
  });
});

describe("money that arrives after its week closed (review 2026-10-13)", () => {
  const NEXT = "2026-10-19";
  const AFTER_NEXT = new Date("2026-10-28T12:00:00Z");

  it("refuses to close a week the bank export doesn't reach the end of", async () => {
    const LATER = "2026-11-02";
    const at = new Date("2026-11-10T12:00:00Z");
    const w = await getWeek(LATER, at);
    expect(w).toMatchObject({ ended: true, bankCovers: false });
    await expect(closeWeek(ceo, LATER, at)).rejects.toThrow(/Import a bank export taken after the week ended/);
  });

  it("carries a receipt dated in a closed week into the next open week, once", async () => {
    // Imported after the week of 12 Oct was closed: $1,500 broker interest ($44 tax) on Briar's loan (Jax's), dated 15 Oct.
    await importRows(
      [[serial("2026-10-15T12:00:00Z"), null, 1500, "transfer", "69530344", "69811362", "Briar Kestrel", 12416, "Broker percentage payment: Loan Agreement Amount: $100000 ID: 5aa31c531970cb5e047d1fbb", 44, 3]],
      "late.xlsx",
    );
    const closed = await getWeek(WEEK, AFTER_NEXT);
    expect(closed.calculation.lines.some((l) => l.label.includes("arrived after"))).toBe(false);

    const next = await getWeek(NEXT, AFTER_NEXT);
    const late = next.calculation.lines.filter((l) => l.label.includes("arrived after its week closed"));
    expect(late).toEqual([expect.objectContaining({ kind: "loan_interest", staffId: jax.staffId, baseCents: 145_600, amountCents: 72_800, label: "Interest — Briar Kestrel · 15 Oct, arrived after its week closed" })]);

    await saveRoster(ceo, { weekKey: NEXT, included: [], lock: true }, AFTER_NEXT);
    expect((await closeWeek(ceo, NEXT, AFTER_NEXT)).totalCents).toBeGreaterThanOrEqual(72_800);
    // Paid now: the following week doesn't show it again.
    const after = await getWeek("2026-10-26", new Date("2026-11-03T12:00:00Z"));
    expect(after.calculation.lines.some((l) => l.label.includes("arrived after"))).toBe(false);
  });
});
