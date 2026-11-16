import "server-only";
import { eq, sql, type SQL } from "drizzle-orm";
import { feeReference } from "@/domain/legal/case-sheet";
import type { db, Tx } from "@/server/db";
import { recordAudit } from "@/server/audit/audit";
import { legalFeeLink, staff } from "@/server/db/schema";

/**
 * Attorney & filing fee payments (owner, 2026-11-10): Pay Employee from the business wallet to the lawyer, filed as
 * `legal` (5400) by the classifier. The sync links a payment whose comment carries a handed-over case's reference
 * ("#LC12") *and* names that case's borrower; anything else is only ever *suggested* on a case page, for a person to
 * confirm. Links are a history (`legal_fee_link`): management can undo a wrong one, and the sync never touches a
 * payment that already has history.
 */

type Executor = typeof db | Tx;

export type FeeRow = { txId: string; occurredAt: Date; amountCents: number; comment: string };

/** Each fee payment's current link (its newest history row, when that's a `link`): `bank_transaction_id, case_id`. */
export const ACTIVE_FEE_LINKS: SQL = sql`(
  select a.bank_transaction_id, a.case_id from (
    select distinct on (f.bank_transaction_id) f.bank_transaction_id, f.case_id, f.action
      from legal_fee_link f order by f.bank_transaction_id, f.id desc) a
   where a.action = 'link')`;

const norm = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
/** The comment names the borrower (two words or more, so a single name can't match by accident). */
export const namesBorrower = (comment: string, borrowerName: string) => {
  const name = norm(borrowerName);
  return name.trim().split(" ").length >= 2 && norm(comment).includes(name);
};

/**
 * Links referenced fee payments. Run by `syncLoans`, so every import, paste and reclassify does it. Idempotent.
 * A linked payment also teaches the app the lawyer's wallet (Pay Employee pays into it), as the pay sheet does for
 * staff: only when the lawyer has none yet and nobody else has that wallet. Fee suggestions need it.
 */
export async function syncLegalFees(tx: Tx): Promise<number> {
  const rows = (
    await tx.execute<{ id: string; comment: string; target_wallet: string | null }>(sql`
      select b.id, b.comment, b.target_wallet from bank_transaction b
       where b.direction = 'out' and b.category = 'legal'
         and not exists (select 1 from legal_fee_link f where f.bank_transaction_id = b.id)`)
  ).rows;
  const referenced = rows.map((r) => ({ ...r, n: feeReference(r.comment) })).filter((r): r is (typeof rows)[number] & { n: number } => r.n !== null);
  if (!referenced.length) return 0;
  const handedOver = (
    await tx.execute<{ id: string; number: number; name: string | null; payee: string }>(sql`
      select c.id, c.number, l.borrower_name as name,
        (select h.payee_staff_id from legal_case_handover h where h.case_id = c.id order by h.handed_at desc limit 1) as payee
        from legal_case c join loan l on l.id = c.loan_id
       where exists (select 1 from legal_case_handover h where h.case_id = c.id)`)
  ).rows;
  const byNumber = new Map(handedOver.map((c) => [Number(c.number), c]));
  const matched = referenced.filter((r) => {
    const c = byNumber.get(r.n);
    return c && c.name && namesBorrower(r.comment, c.name);
  });
  if (matched.length) {
    await tx.insert(legalFeeLink).values(matched.map((r) => ({ bankTransactionId: r.id, caseId: byNumber.get(r.n)!.id, action: "link", method: "reference" })));
  }
  for (const r of matched) {
    const payee = byNumber.get(r.n)!.payee;
    if (!r.target_wallet) continue;
    const [p] = await tx.select({ walletId: staff.walletId }).from(staff).where(eq(staff.id, payee));
    if (!p || p.walletId) continue;
    const [taken] = await tx.select({ id: staff.id }).from(staff).where(eq(staff.walletId, r.target_wallet));
    if (taken) continue;
    await tx.update(staff).set({ walletId: r.target_wallet, updatedAt: new Date() }).where(eq(staff.id, payee));
    await recordAudit(tx, {
      actor: { type: "system" },
      action: "legal.lawyer_wallet_learned",
      target: { type: "staff", id: payee },
      metadata: { staffId: payee, walletId: r.target_wallet, bankTransactionId: r.id },
    });
  }
  return matched.length;
}

/**
 * Unlinked legal-fee payments from a day before the first hand-over that could be this case's fee — never one a person
 * unlinked from this case. Either the comment names the borrower, or it's the fee's exact amount paid to the case's
 * lawyer and doesn't point at another case (no other handed-over borrower named, no other case's #LC number).
 */
export async function feeSuggestions(
  executor: Executor,
  c: { caseId: string; caseNumber: number; borrowerName: string; since: Date; feeCents: number; payeeWallet: string | null },
): Promise<FeeRow[]> {
  const rows = (
    await executor.execute<{ id: string; occurred_at: Date | string; amount_cents: string | number; comment: string; target_wallet: string | null }>(sql`
      select b.id, b.occurred_at, b.amount_cents, b.comment, b.target_wallet from bank_transaction b
       where b.direction = 'out' and b.category = 'legal' and b.occurred_at >= ${new Date(c.since.getTime() - 86_400_000)}
         and not exists (select 1 from ${ACTIVE_FEE_LINKS} a where a.bank_transaction_id = b.id)
         and not exists (select 1 from legal_fee_link f where f.bank_transaction_id = b.id and f.case_id = ${c.caseId} and f.action = 'unlink')
       order by b.occurred_at`)
  ).rows;
  if (!rows.length) return [];
  const others = (
    await executor.execute<{ name: string | null }>(sql`
      select l.borrower_name as name from legal_case lc join loan l on l.id = lc.loan_id
       where lc.id <> ${c.caseId} and exists (select 1 from legal_case_handover h where h.case_id = lc.id)`)
  ).rows.flatMap((r) => (r.name ? [r.name] : []));
  const toLawyer = (r: (typeof rows)[number]) => {
    const ref = feeReference(r.comment);
    return (
      c.payeeWallet !== null &&
      r.target_wallet === c.payeeWallet &&
      Number(r.amount_cents) === c.feeCents &&
      (ref === null || ref === c.caseNumber) &&
      !others.some((n) => n !== c.borrowerName && namesBorrower(r.comment, n))
    );
  };
  return rows
    .filter((r) => namesBorrower(r.comment, c.borrowerName) || toLawyer(r))
    .map((r) => ({ txId: r.id, occurredAt: new Date(r.occurred_at), amountCents: Number(r.amount_cents), comment: r.comment }));
}

/** Whether a bank row is currently a case's fee payment (it then can't be reclassified). */
export async function activeFeeLink(executor: Executor, bankTransactionId: string): Promise<{ caseId: string } | null> {
  const [r] = (await executor.execute<{ case_id: string }>(sql`select a.case_id from ${ACTIVE_FEE_LINKS} a where a.bank_transaction_id = ${bankTransactionId}`)).rows;
  return r ? { caseId: r.case_id } : null;
}
