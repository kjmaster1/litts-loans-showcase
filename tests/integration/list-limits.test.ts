import { beforeAll, describe, expect, it } from "vitest";
import { SERVER_AGGREGATE } from "@/server/authz/rules";

const { listLoans } = await import("@/server/loans/queries");
const { db } = await import("@/server/db");
const { loan } = await import("@/server/db/schema");
const { resetDb } = await import("../support/db");

/**
 * Reports, expected losses and the borrower directory total `listLoans`. It once stopped at 500 rows, which would
 * have quietly dropped the oldest loans from every total (review 2026-10-13).
 */
describe("the loan list", () => {
  const COUNT = 520;

  beforeAll(async () => {
    await resetDb();
    await db.insert(loan).values(
      Array.from({ length: COUNT }, (_, i) => ({ borrowerStateId: 70_000 + i, principalCents: 100_000, status: "active" as const, openedAt: new Date(Date.UTC(2026, 0, 1) + i * 3_600_000) })),
    );
  });

  it("returns every loan, however many there are", async () => {
    const rows = await listLoans(SERVER_AGGREGATE, { status: "all" });
    expect(rows).toHaveLength(COUNT);
    // The oldest is still there.
    expect(rows.at(-1)?.borrowerStateId).toBe(70_000);
  });
});
