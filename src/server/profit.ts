import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/server/db";

/**
 * What each loan and mortgage has made for Litt's (research/12), straight from the
 * books: income less expenses on every journal entry tied to it — interest and fees
 * net of tax withheld, less the State levy, closing differences and write-offs,
 * plus recoveries. Before commission (paid per week, not per loan). Reversals of
 * those entries are included so a correction nets out.
 */

export async function loanProfits(): Promise<Map<string, number>> {
  const result = await db.execute<{ id: string; profit: string }>(sql`
    with base as (
      select l.loan_id as id, je.id as entry_id
        from loan_payment_link l join journal_entry je on je.bank_transaction_id = l.bank_transaction_id
      union select a.loan_id, a.journal_entry_id from loan_adjustment a
      union select id, write_off_entry_id from loan where write_off_entry_id is not null
    ), e as (
      select * from base
      union select b.id, r.id from journal_entry r join base b on r.reverses_entry_id = b.entry_id
    )
    select e.id, sum(jl.credit_cents - jl.debit_cents) as profit
      from e join journal_line jl on jl.entry_id = e.entry_id join ledger_account a on a.code = jl.account_code
     where a.type in ('income', 'expense')
     group by e.id`);
  return new Map(result.rows.map((r) => [r.id, Number(r.profit)]));
}

export async function mortgageProfits(): Promise<Map<string, number>> {
  const result = await db.execute<{ id: string; profit: string }>(sql`
    with tx as (
      select id, origination_tx_id as tx_id from mortgage where origination_tx_id is not null and merged_into_id is null
      union select mortgage_id, bank_transaction_id from mortgage_payment
    ), legs as (
      select * from tx
      union select tx.id, s.out_tx_id from tx join mortgage_settlement s on s.in_tx_id = tx.tx_id
    ), base as (
      select legs.id, je.id as entry_id from legs join journal_entry je on je.bank_transaction_id = legs.tx_id
      union select tx.id, s.journal_entry_id from tx join mortgage_settlement s on s.in_tx_id = tx.tx_id where s.journal_entry_id is not null
      union select id, funding_entry_id from mortgage where funding_entry_id is not null
    ), e as (
      select * from base
      union select b.id, r.id from journal_entry r join base b on r.reverses_entry_id = b.entry_id
    )
    select e.id, sum(jl.credit_cents - jl.debit_cents) as profit
      from e join journal_line jl on jl.entry_id = e.entry_id join ledger_account a on a.code = jl.account_code
     where a.type in ('income', 'expense')
     group by e.id`);
  return new Map(result.rows.map((r) => [r.id, Number(r.profit)]));
}
