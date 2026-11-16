import { bigserial, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Server errors seen in production (2026-10-11): written by `instrumentation.ts` and
 * `runAction`, read by the daily health check (.github/workflows/health.yml), which emails
 * the owner through GitHub. Operational only — no request bodies, no search text.
 */
export const appError = pgTable(
  "app_error",
  {
    id: bigserial({ mode: "bigint" }).primaryKey(),
    occurredAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** render | route | action | proxy | action-handled */
    source: text().notNull(),
    /** The route file (e.g. /loans/[id]), never the URL with its query. */
    route: text(),
    method: text(),
    message: text().notNull(),
    digest: text(),
  },
  (t) => [index("app_error_occurred_idx").on(t.occurredAt)],
);
