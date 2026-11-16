import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { staff } from "./staff";

/**
 * Company settings, one full version per change (research/11). Append-only; the
 * newest version applies. Closed commission weeks keep the rates they were
 * closed with (stored on the week).
 */
export const companySetting = pgTable("company_setting", {
  id: uuid().primaryKey().defaultRandom(),
  values: jsonb().$type<Record<string, unknown>>().notNull(),
  reason: text().notNull(),
  createdByStaffId: uuid()
    .notNull()
    .references(() => staff.id),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
