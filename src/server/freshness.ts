import "server-only";
import { cache } from "react";
import { sql } from "drizzle-orm";
import { db } from "@/server/db";

/**
 * How current the data is (research/12): everything in the app comes from three
 * hand-fed sources — the bank export, the phone's loan tabs and the tablet — so
 * list pages say when each was last brought in.
 */
export type Freshness = {
  /** Newest bank row on record (its own time), and when the last export was imported. */
  bankTo: Date | null;
  bankImportedAt: Date | null;
  /** Oldest of the four phone tabs' latest pastes: the loan statuses are at least this fresh. */
  cardsAt: Date | null;
  tabletAt: Date | null;
};

export const dataFreshness = cache(async (): Promise<Freshness> => {
  const result = await db.execute<{ bank_to: Date | null; imported: Date | null; cards: Date | null; tablet: Date | null }>(sql`
    select (select max(occurred_at) from bank_transaction) as bank_to,
           (select max(created_at) from import_batch) as imported,
           (select min(t.at) from (select max(captured_at) as at from loan_paste group by tab) t) as cards,
           (select max(captured_at) from mortgage_paste) as tablet`);
  const r = result.rows[0];
  const d = (v: Date | string | null) => (v ? new Date(v) : null);
  return { bankTo: d(r.bank_to), bankImportedAt: d(r.imported), cardsAt: d(r.cards), tabletAt: d(r.tablet) };
});
