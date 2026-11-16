import { sql } from "drizzle-orm";
import { db } from "@/server/db";

/**
 * Clears mutable tables between test files. `audit_event` is append-only by
 * design (truncate is blocked by trigger), so tests never assume it's empty.
 */
export async function resetDb() {
  await resetLedger(); // loans reference staff
  await db.execute(sql`delete from staff_invite`);
  await db.execute(sql`delete from staff`);
  await db.execute(sql`delete from session`);
  await db.execute(sql`delete from two_factor`);
  await db.execute(sql`delete from account`);
  await db.execute(sql`delete from "user"`);
  await db.execute(sql`delete from rate_limit`);
  await db.execute(sql`delete from verification`);
}

/**
 * Empties the ledger. The journal is append-only in every real environment;
 * only the test database's superuser can bypass the triggers, and only for
 * this one transaction (session_replication_role = replica skips triggers).
 */
export async function resetLedger() {
  await db.transaction(async (tx) => {
    await tx.execute(sql`set local session_replication_role = replica`);
    await tx.execute(
      sql`truncate loan_offer, mortgage_quote_note, mortgage_quote, notification_read, staff_password_reset, company_setting, borrower_flag, loan_collection_action, commission_payout, commission_award, commission_line, commission_roster, commission_week, allowance_reading, app_setting, mortgage_event, mortgage_snapshot, mortgage_paste, mortgage_payment, mortgage, loan_adjustment, loan_collateral, loan_event, loan_card, loan_paste, loan_payment_link, loan, mortgage_settlement, journal_line, journal_entry, bank_transaction, import_staging, import_batch restart identity cascade`,
    );
  });
}
