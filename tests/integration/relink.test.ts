import { readFileSync } from "node:fs";
import { and, eq, inArray, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/request", () => ({ getRequestMeta: async () => ({ ip: "203.0.113.10", userAgent: "vitest" }) }));

const { commitImport, cashBalanceCents, stageImport } = await import("@/server/bank/import");
const { commitPaste } = await import("@/server/loans/paste");
const { applyRelink, proposeRelink, relinkSuggestions } = await import("@/server/loans/relink");
const { db } = await import("@/server/db");
const { auditEvent, loan, loanCard, loanPaymentLink, staff } = await import("@/server/db/schema");
const { resetDb } = await import("../support/db");

type Viewer = import("@/server/authz/viewer").Viewer;
let ceo: Viewer;

const one = async <T,>(q: Promise<{ rows: T[] }>) => (await q).rows[0];

beforeAll(async () => {
  await resetDb();
  const [row] = await db.insert(staff).values({ stateId: 424242, characterName: "Relink Tester", role: "ceo", status: "active" }).returning();
  ceo = { staffId: row.id, userId: "u", sessionId: "s", role: "ceo", characterName: row.characterName, stateId: row.stateId, username: "r", twoFactorEnabled: true, stepUpAt: null, tourCompletedAt: null, tourRole: null };
  await commitImport(ceo, await stageImport(ceo, { name: "export.xlsx", bytes: readFileSync("tests/fixtures/bank-export.xlsx") }));
  for (const tab of ["active", "overdue", "default", "complete"] as const) {
    await commitPaste(ceo, { tab, text: readFileSync(`tests/fixtures/paste-${tab}.txt`, "utf8") });
  }
});

describe("correcting payments recorded against the wrong loan", () => {
  it("finds nothing to correct straight after import (the matcher already got it right)", async () => {
    expect(await relinkSuggestions()).toEqual([]);
  });

  it("moves payments back and corrects swapped terms", async () => {
    // A borrower with two loans whose terms differ.
    const pair = await one(
      db.execute<{ a: string; b: string; sid: number }>(sql`
        select a.id as a, b.id as b, a.borrower_state_id as sid from loan a join loan b
          on a.borrower_state_id = b.borrower_state_id and a.opened_at < b.opened_at
        where a.status = 'completed' and b.status = 'completed' and a.instalments <> b.instalments
          and exists (select 1 from loan_payment_link k where k.loan_id = a.id and k.method in ('agreement', 'reference'))
        limit 1`),
    );
    expect(pair).toBeDefined();
    const [a, b] = await db.select().from(loan).where(inArray(loan.id, [pair.a, pair.b]));
    const A = a.id === pair.a ? a : b;
    const B = a.id === pair.a ? b : a;

    // Simulate the old mistake: one of A's identified payments on B, and the two loans' terms and cards swapped.
    const [moved] = await db
      .select()
      .from(loanPaymentLink)
      .where(and(eq(loanPaymentLink.loanId, A.id), inArray(loanPaymentLink.method, ["agreement", "reference"])))
      .limit(1);
    await db.update(loanPaymentLink).set({ loanId: B.id, method: "open_loan" }).where(eq(loanPaymentLink.bankTransactionId, moved.bankTransactionId));
    await db.update(loan).set({ instalments: B.instalments, brokerRateBp: B.brokerRateBp }).where(eq(loan.id, A.id));
    await db.update(loan).set({ instalments: A.instalments, brokerRateBp: A.brokerRateBp }).where(eq(loan.id, B.id));
    await db.execute(sql`update loan_card set loan_id = case when loan_id = ${A.id} then ${B.id}::uuid else ${A.id}::uuid end where loan_id in (${A.id}, ${B.id})`);

    const proposal = await proposeRelink(pair.sid);
    expect(proposal).toEqual([expect.objectContaining({ txId: moved.bankTransactionId, fromLoanId: B.id, toLoanId: A.id })]);
    expect((await relinkSuggestions()).map((s) => s.stateId)).toEqual([pair.sid]);

    const officer = { ...ceo, role: "loan_officer" as const };
    await expect(applyRelink(officer, { stateId: pair.sid, reason: "Two loans at once" })).rejects.toThrow(/permission/);

    const cash = await cashBalanceCents();
    const result = await applyRelink(ceo, { stateId: pair.sid, reason: "Two loans at once; payments matched to the wrong one" });
    expect(result.moved).toBe(1);
    expect(result.termsCorrected).toBe(2);

    const [link] = await db.select().from(loanPaymentLink).where(eq(loanPaymentLink.bankTransactionId, moved.bankTransactionId));
    expect(link.loanId).toBe(A.id);
    const [a2] = await db.select().from(loan).where(eq(loan.id, A.id));
    expect({ instalments: a2.instalments, brokerRateBp: a2.brokerRateBp }).toEqual({ instalments: A.instalments, brokerRateBp: A.brokerRateBp });
    const cards = await db.select({ loanId: loanCard.loanId }).from(loanCard).where(inArray(loanCard.loanId, [A.id, B.id]));
    expect(cards.length).toBeGreaterThan(0);

    // The books follow: cash untouched, levy booked = levy recorded, everything balances.
    expect(await cashBalanceCents()).toBe(cash);
    const levyBooked = Number((await one(db.execute<{ b: string }>(sql`select coalesce(sum(debit_cents - credit_cents), 0) as b from journal_line where account_code = '5100'`))).b);
    const levyRecorded = Number((await one(db.execute<{ s: string }>(sql`select coalesce(sum(levy_cents), 0) as s from loan_payment_link`))).s);
    expect(levyBooked).toBe(levyRecorded);
    const balanced = await one(db.execute<{ ok: boolean }>(sql`select sum(debit_cents) = sum(credit_cents) as ok from journal_line`));
    expect(balanced.ok).toBe(true);

    const [event] = await db.select().from(auditEvent).where(eq(auditEvent.action, "loans.payments.relinked"));
    expect(event).toMatchObject({ reason: "Two loans at once; payments matched to the wrong one", targetId: String(pair.sid) });
    expect(await proposeRelink(pair.sid)).toEqual([]);
  });

  it("refuses when there's nothing to correct", async () => {
    const [{ sid }] = (await db.execute<{ sid: number }>(sql`select borrower_state_id as sid from loan limit 1`)).rows;
    await expect(applyRelink(ceo, { stateId: sid, reason: "Checking" })).rejects.toThrow(/Nothing to correct/);
  });
});
