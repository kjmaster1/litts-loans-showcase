import { expect, test } from "@playwright/test";
import pg from "pg";
import { statePath } from "./support";

/**
 * QA of 13 October 2026 (docs/qa/QA-2026-10-13.md): what the loan pages show agrees with the phone.
 */

async function query<T extends pg.QueryResultRow>(text: string): Promise<T[]> {
  if (!process.env.DATABASE_URL) process.loadEnvFile?.(".env.local");
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    return (await db.query<T>(text)).rows;
  } finally {
    await db.end();
  }
}

test.describe("CEO", () => {
  test.use({ storageState: statePath("ceo") });

  test("a late repayment counts as a paid instalment on the schedule, as on the phone", async ({ page }) => {
    const rows = await query<{ id: string; paid: number }>(`
      select l.id, greatest(coalesce(l.last_completed, 0),
             (select count(*) from loan_payment_link k where k.loan_id = l.id and k.role in ('principal', 'late_principal')))::int as paid
        from loan l
       where l.retired_at is null and l.instalments is not null and l.broker_rate_bp is not null
         and exists (select 1 from loan_payment_link k where k.loan_id = l.id and k.role = 'late_principal')
       order by l.opened_at desc limit 1`);
    test.skip(!rows[0], "needs a loan with a late repayment (E2E_SEED=1)");
    await page.goto(`/loans/${rows[0].id}`, { waitUntil: "networkidle" });
    const schedule = page.locator("table").filter({ has: page.getByRole("columnheader", { name: "Borrower pays" }) });
    await expect(schedule.locator("tbody").getByText("Paid", { exact: true })).toHaveCount(rows[0].paid);
  });

  test("an open loan shows the phone's own remaining figure next to what the books say", async ({ page }) => {
    const rows = await query<{ id: string }>(`
      select id from loan where retired_at is null and status in ('active', 'overdue', 'defaulted')
         and last_remaining_cents is not null and last_card_at is not null order by opened_at desc limit 1`);
    test.skip(!rows[0], "needs an open loan with a pasted card (E2E_SEED=1)");
    await page.goto(`/loans/${rows[0].id}`, { waitUntil: "networkidle" });
    await expect(page.getByText(/^Phone: \$[\d,]+ on /)).toBeVisible();
  });

  test("an instalment carrying the game's overdue penalty says so (booked as a late fee)", async ({ page }) => {
    const rows = await query<{ id: string; penalty: string }>(`
      select k.loan_id as id, k.penalty_cents as penalty from loan_payment_link k join loan l on l.id = k.loan_id
       where k.penalty_cents > 0 and l.retired_at is null order by k.penalty_cents desc limit 1`);
    test.skip(!rows[0], "needs a loan with an overdue penalty, after a sync (E2E_SEED=1)");
    await page.goto(`/loans/${rows[0].id}`, { waitUntil: "networkidle" });
    const dollars = (Number(rows[0].penalty) / 100).toLocaleString("en-US");
    await expect(page.getByText(`Includes $${dollars} overdue penalty (late fee)`).first()).toBeVisible();
  });

  test("the loans list never shows a negative balance", async ({ page }) => {
    await page.goto("/loans?status=all", { waitUntil: "networkidle" });
    await expect(page.locator("#results tbody tr").first()).toBeVisible();
    await expect(page.locator("#results")).not.toContainText(/[−-]\$\d/);
  });
});
