import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/server/db";

/**
 * Records the bank data should have confirmed by now but hasn't (2026-10-12 data-quality
 * review): a mortgage known only from the tablet, or a loan known only from a phone card,
 * created more than a day before the newest bank row imported. Its money would be in that
 * export, so it is most likely a duplicate or a mistyped paste — fix it by merging/removing
 * it on its page. Same rule as scripts/ops/health-check.mjs.
 */

export const UNCONFIRMED_GRACE_HOURS = 24;

export type UnconfirmedRecord = {
  kind: "mortgage" | "loan";
  id: string;
  /** Address, or the loan's amount. */
  label: string;
  borrowerName: string | null;
  borrowerStateId: number | null;
  principalCents: number | null;
  createdAt: Date;
  href: string;
};

export async function unconfirmedRecords(): Promise<UnconfirmedRecord[]> {
  const { rows } = await db.execute<{
    kind: "mortgage" | "loan";
    id: string;
    label: string;
    name: string | null;
    state_id: number | null;
    principal: string | null;
    created_at: Date | string;
  }>(sql`
    with bank as (select max(last_tx_at) as newest from import_batch)
    select 'mortgage' as kind, m.id, m.address as label, m.buyer_name as name, m.buyer_state_id as state_id, null::bigint as principal, m.created_at
      from mortgage m, bank
     where m.merged_into_id is null and m.origination_tx_id is null and m.last_tablet_at is not null
       and m.created_at < bank.newest - make_interval(hours => ${UNCONFIRMED_GRACE_HOURS})
    union all
    select 'loan', l.id, null, l.borrower_name, l.borrower_state_id, l.principal_cents, l.created_at
      from loan l, bank
     where l.disbursement_tx_id is null and l.retired_at is null
       and l.created_at < bank.newest - make_interval(hours => ${UNCONFIRMED_GRACE_HOURS})
     order by created_at`);
  return rows.map((r) => ({
    kind: r.kind,
    id: r.id,
    label: r.label ?? "",
    borrowerName: r.name,
    borrowerStateId: r.state_id,
    principalCents: r.principal === null ? null : Number(r.principal),
    createdAt: new Date(r.created_at),
    href: r.kind === "mortgage" ? `/mortgages/${r.id}` : `/loans/${r.id}`,
  }));
}
