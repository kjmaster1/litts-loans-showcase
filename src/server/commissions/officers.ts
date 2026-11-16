import "server-only";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { CATCH_UP_FROM, COMMISSION_START } from "@/domain/commissions/week";
import { can, ForbiddenError } from "@/lib/permissions";
import { recordAudit } from "@/server/audit/audit";
import type { Viewer } from "@/server/authz/viewer";
import { db, type Tx } from "@/server/db";
import { bankTransaction, commissionPayout, liveLoan, loan, loanEvent, staff } from "@/server/db/schema";
import { LoanError } from "@/server/loans/errors";
import { getRequestMeta } from "@/server/request";
import { interestReceipts, matchOldItems, matchPayout, oldCommissionItems, type OldItem } from "./service";
import { isWorkingStatus } from "@/lib/roles";

/**
 * Officers suggested from the hand-paid commission runs before the scheme
 * (research/10): whoever was paid for a loan's interest was its officer.
 */

type Executor = typeof db | Tx;

export type OldWallet = { wallet: string; staffId: string | null; staffName: string | null; payouts: number; lastPaidAt: Date; borrowers: number };

export type OfficerSuggestion = {
  loanId: string;
  borrower: string;
  status: string;
  wallet: string;
  /** The person the wallet belongs to, once it's been linked. */
  staffId: string | null;
  /** "loan": paid for this loan's own interest; "borrower": paid for an earlier loan of theirs. */
  basis: "loan" | "borrower";
  lastPaidAt: Date;
  /** Has interest in the catch-up period, so it needs an officer before that can be closed. */
  inCatchUp: boolean;
};

const OPEN = ["active", "overdue", "defaulted"];
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const latest = (items: OldItem[]) => items.reduce<OldItem | null>((a, b) => (!a || b.paidAt > a.paidAt ? b : a), null);

export async function officerSuggestions(executor: Executor = db): Promise<{ wallets: OldWallet[]; suggestions: OfficerSuggestion[] }> {
  const items = (await oldCommissionItems(executor)).filter((i) => i.wallet);
  if (items.length === 0) return { wallets: [], suggestions: [] };
  const receipts = await interestReceipts(executor, new Date(0), COMMISSION_START);
  const covered = matchOldItems(receipts, items);
  const people = await executor.select({ id: staff.id, name: staff.characterName, walletId: staff.walletId, status: staff.status }).from(staff);
  const byWallet = new Map(people.filter((p) => p.walletId && isWorkingStatus(p.status)).map((p) => [p.walletId!, p]));

  const wallets = new Map<string, OldItem[]>();
  for (const i of items) wallets.set(i.wallet!, [...(wallets.get(i.wallet!) ?? []), i]);

  const byLoan = new Map<string, OldItem[]>();
  for (const r of receipts) {
    const item = covered.get(r.txId);
    if (item) byLoan.set(r.loanId, [...(byLoan.get(r.loanId) ?? []), item]);
  }
  const byBorrower = new Map<string, OldItem[]>();
  for (const i of items) byBorrower.set(norm(i.name), [...(byBorrower.get(norm(i.name)) ?? []), i]);

  // Loans with interest in the catch-up that no old payment covered.
  const inCatchUp = new Set(receipts.filter((r) => r.at >= CATCH_UP_FROM && !covered.has(r.txId)).map((r) => r.loanId));
  const loans = await executor
    .select({ id: loan.id, borrower: loan.borrowerName, stateId: loan.borrowerStateId, status: loan.status })
    .from(loan)
    .where(and(liveLoan, isNull(loan.officerStaffId)));

  const suggestions: OfficerSuggestion[] = [];
  for (const l of loans) {
    if (!OPEN.includes(l.status) && !inCatchUp.has(l.id)) continue; // nothing more to earn
    const own = latest(byLoan.get(l.id) ?? []);
    const earlier = own ? null : l.borrower ? latest(byBorrower.get(norm(l.borrower)) ?? []) : null;
    const item = own ?? earlier;
    if (!item) continue;
    suggestions.push({
      loanId: l.id,
      borrower: l.borrower ?? `State ID ${l.stateId}`,
      status: l.status,
      wallet: item.wallet!,
      staffId: byWallet.get(item.wallet!)?.id ?? null,
      basis: own ? "loan" : "borrower",
      lastPaidAt: item.paidAt,
      inCatchUp: inCatchUp.has(l.id),
    });
  }
  suggestions.sort((a, b) => Number(b.inCatchUp) - Number(a.inCatchUp) || a.borrower.localeCompare(b.borrower));

  return {
    wallets: [...wallets]
      .map(([wallet, list]) => {
        const p = byWallet.get(wallet);
        return {
          wallet,
          staffId: p?.id ?? null,
          staffName: p?.name ?? null,
          payouts: new Set(list.map((i) => i.payoutTxId)).size,
          lastPaidAt: latest(list)!.paidAt,
          borrowers: new Set(list.map((i) => norm(i.name))).size,
        };
      })
      .sort((a, b) => b.lastPaidAt.getTime() - a.lastPaidAt.getTime()),
    suggestions,
  };
}

export const linkWalletSchema = z.object({ wallet: z.string().regex(/^\d{4,12}$/), staffId: z.uuid() });

/**
 * Records whose wallet an old commission payment went to. Later payouts to it
 * then match by themselves, and its old payments suggest officers. Management+.
 */
export async function linkWallet(viewer: Viewer, raw: z.input<typeof linkWalletSchema>): Promise<{ payoutsMatched: number }> {
  if (!can(viewer.role, "commissions.manage")) throw new ForbiddenError();
  const input = linkWalletSchema.parse(raw);
  const request = await getRequestMeta();
  return db.transaction(async (tx) => {
    const [s] = await tx.select().from(staff).where(eq(staff.id, input.staffId)).for("update");
    if (!s || !isWorkingStatus(s.status)) throw new LoanError("Choose a current staff member.");
    if (s.walletId === input.wallet) return { payoutsMatched: 0 };
    if (s.walletId) throw new LoanError(`${s.characterName} already has wallet ${s.walletId}.`);
    const [taken] = await tx.select({ name: staff.characterName }).from(staff).where(eq(staff.walletId, input.wallet));
    if (taken) throw new LoanError(`That wallet already belongs to ${taken.name}.`);
    await tx.update(staff).set({ walletId: input.wallet, updatedAt: new Date() }).where(eq(staff.id, s.id));

    // Payouts since the scheme started that were waiting for this wallet.
    const waiting = await tx
      .select({ id: commissionPayout.bankTransactionId })
      .from(commissionPayout)
      .innerJoin(bankTransaction, eq(bankTransaction.id, commissionPayout.bankTransactionId))
      .where(and(eq(commissionPayout.status, "unmatched"), eq(bankTransaction.targetWallet, input.wallet)));
    for (const w of waiting) await matchPayout(tx, w.id, s.id, "wallet", viewer.staffId);

    await recordAudit(tx, {
      actor: { type: "staff", staffId: viewer.staffId },
      action: "commissions.wallet_linked",
      target: { type: "staff", id: s.id },
      metadata: { wallet: input.wallet, payoutsMatched: waiting.length },
      request,
    });
    return { payoutsMatched: waiting.length };
  });
}

export const applySuggestionsSchema = z.object({ loanIds: z.array(z.uuid()).min(1).max(500) });

/** Assigns the suggested officers the user ticked (only to loans still without one). Management+. */
export async function applyOfficerSuggestions(viewer: Viewer, raw: z.input<typeof applySuggestionsSchema>): Promise<{ assigned: number }> {
  if (!can(viewer.role, "loans.reassign_officer")) throw new ForbiddenError();
  const input = applySuggestionsSchema.parse(raw);
  const request = await getRequestMeta();
  const { suggestions } = await officerSuggestions();
  const wanted = new Set(input.loanIds);
  const chosen = suggestions.filter((s) => wanted.has(s.loanId) && s.staffId);
  if (chosen.length === 0) throw new LoanError("None of those loans has a suggested officer any more.");
  const reason = "Suggested from past commission payments";

  return db.transaction(async (tx) => {
    const locked = await tx
      .select({ id: loan.id })
      .from(loan)
      .where(and(inArray(loan.id, chosen.map((c) => c.loanId)), isNull(loan.officerStaffId)))
      .for("update");
    const free = new Set(locked.map((l) => l.id));
    const now = new Date();
    let assigned = 0;
    for (const c of chosen) {
      if (!free.has(c.loanId)) continue;
      await tx.update(loan).set({ officerStaffId: c.staffId, updatedAt: now }).where(eq(loan.id, c.loanId));
      await tx.insert(loanEvent).values({
        loanId: c.loanId,
        at: now,
        kind: "officer_assigned",
        staffId: viewer.staffId,
        detail: { from: null, to: c.staffId, reason, wallet: c.wallet, basis: c.basis },
      });
      await recordAudit(tx, {
        actor: { type: "staff", staffId: viewer.staffId },
        action: "loans.officer_assigned",
        target: { type: "loan", id: c.loanId },
        reason,
        metadata: { from: null, to: c.staffId, source: "old_commission", wallet: c.wallet, basis: c.basis },
        request,
      });
      assigned++;
    }
    return { assigned };
  });
}
