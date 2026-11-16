import { pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { staff } from "./staff";

/**
 * Which notifications a person has read (research/12). Notifications themselves are
 * worked out from the data on each request; only "seen" is stored, by a stable key
 * such as `broken:<collection action id>`.
 */
export const notificationRead = pgTable(
  "notification_read",
  {
    staffId: uuid()
      .notNull()
      .references(() => staff.id),
    key: text().notNull(),
    readAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.staffId, t.key] })],
);
