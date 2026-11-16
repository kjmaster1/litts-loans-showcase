import "server-only";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { can, ForbiddenError } from "@/lib/permissions";
import { recordAudit } from "@/server/audit/audit";
import { requireFreshStepUp } from "@/server/auth/step-up-guard";
import type { Viewer } from "@/server/authz/viewer";
import { db, type Db, type Tx } from "@/server/db";
import { journalEntry, journalLine } from "@/server/db/schema";
import { LoanError } from "@/server/loans/errors";
import { getRequestMeta } from "@/server/request";

/**
 * Old loans from staff to the company, account 2200 (research/11): all finished
 * and no longer done. Per lender: anything never shown repaid was settled outside
 * the business wallet (booked to 3200), anything repaid beyond what they lent was
 * interest (5150).
 */

export type StaffLender = { name: string; stateId: number | null; lentCents: number; repaidCents: number; balanceCents: number };
export type StaffLoans = { balanceCents: number; lenders: StaffLender[]; lastActivity: Date | null };

export async function staffLoans(executor: Db | Tx = db): Promise<StaffLoans> {
  const [bal] = (await executor.execute<{ b: string }>(sql`select coalesce(sum(credit_cents - debit_cents), 0) as b from journal_line where account_code = '2200'`)).rows;
  const rows = (
    await executor.execute<{ category: string; amount: string; at: Date; sid: number | null; name: string | null; walletSid: number | null; walletName: string | null }>(sql`
      select b.category, b.amount_cents as amount, b.occurred_at as at, b.initiator_state_id as sid, b.initiator_name as name,
             s.state_id as "walletSid", s.character_name as "walletName"
      from bank_transaction b
      left join staff s on s.wallet_id = b.target_wallet
      where b.category in ('staff_loan.received', 'staff_loan.repaid')`)
  ).rows;
  // Money in: the lender is whoever paid it in. Money out: the person who made the
  // repayment if they lent money, else the owner of the wallet it went to.
  const lent = new Map<string, { name: string; sid: number | null }>();
  const key = (sid: number | null, name: string | null) => (sid !== null ? `id:${sid}` : `name:${name ?? "Unknown"}`);
  for (const r of rows) if (r.category === "staff_loan.received") lent.set(key(r.sid, r.name), { name: r.name ?? "Unknown", sid: r.sid });
  const by = new Map<string, StaffLender>();
  for (const r of rows) {
    const who =
      r.category === "staff_loan.received" || lent.has(key(r.sid, r.name)) || r.walletSid === null
        ? { k: key(r.sid, r.name), name: r.name ?? "Unknown", sid: r.sid }
        : { k: key(r.walletSid, r.walletName), name: r.walletName ?? "Unknown", sid: r.walletSid };
    const l = by.get(who.k) ?? { name: lent.get(who.k)?.name ?? who.name, stateId: who.sid, lentCents: 0, repaidCents: 0, balanceCents: 0 };
    if (r.category === "staff_loan.received") l.lentCents += Number(r.amount);
    else l.repaidCents += Number(r.amount);
    l.balanceCents = l.lentCents - l.repaidCents;
    by.set(who.k, l);
  }
  const lenders = [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
  const last = rows.map((r) => new Date(r.at).getTime());
  return { balanceCents: Number(bal.b), lenders, lastActivity: last.length ? new Date(Math.max(...last)) : null };
}

export const closeStaffLoansSchema = z.object({ reason: z.string().trim().min(5, "Give a reason (at least 5 characters).").max(500) });

/** Clears 2200 in one adjustment. Sensitive: fresh 2FA + reason. */
export async function closeStaffLoans(viewer: Viewer, raw: z.input<typeof closeStaffLoansSchema>): Promise<{ entryId: string }> {
  if (!can(viewer.role, "ledger.adjust")) throw new ForbiddenError();
  requireFreshStepUp(viewer);
  const input = closeStaffLoansSchema.parse(raw);
  const request = await getRequestMeta();

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${0x4c4c534c})`); // "LLSL"
    const s = await staffLoans(tx);
    if (s.balanceCents === 0) throw new LoanError("There's nothing to clear: the staff loans account is already at zero.");
    const net = s.lenders.reduce((sum, l) => sum + l.balanceCents, 0);
    if (net !== s.balanceCents) throw new LoanError("The staff loan rows don't add up to the account's balance; reclassify them first.");

    const entryId = randomUUID();
    const lines: (typeof journalLine.$inferInsert)[] = [];
    for (const l of s.lenders) {
      if (l.balanceCents > 0) {
        const memo = `${l.name}: settled outside the business wallet`;
        lines.push({ entryId, accountCode: "2200", debitCents: l.balanceCents, creditCents: 0, memo }, { entryId, accountCode: "3200", debitCents: 0, creditCents: l.balanceCents, memo });
      } else if (l.balanceCents < 0) {
        const memo = `${l.name}: repaid beyond what they lent (interest)`;
        lines.push({ entryId, accountCode: "5150", debitCents: -l.balanceCents, creditCents: 0, memo }, { entryId, accountCode: "2200", debitCents: 0, creditCents: -l.balanceCents, memo });
      }
    }
    await tx.insert(journalEntry).values({
      id: entryId,
      effectiveAt: s.lastActivity ?? new Date(),
      kind: "adjustment",
      description: "Old staff loans closed out",
      createdByStaffId: viewer.staffId,
      reason: input.reason,
    });
    await tx.insert(journalLine).values(lines);
    await recordAudit(tx, {
      actor: { type: "staff", staffId: viewer.staffId },
      action: "ledger.staff_loans.closed",
      target: { type: "journal_entry", id: entryId },
      reason: input.reason,
      metadata: { lenders: s.lenders.map((l) => ({ name: l.name, balanceCents: l.balanceCents })), balanceCents: s.balanceCents },
      request,
    });
    return { entryId };
  });
}
