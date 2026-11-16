import { expect, test } from "@playwright/test";
import pg from "pg";
import { statePath, watchErrors } from "./support";

/**
 * UX review of 12 October 2026 (docs/design/UX-REVIEW-2026-10-12.md): the fixes a first-time
 * user would notice, kept from regressing.
 */

test("sign-in says how to get back in without a password, and what the app is", async ({ page }) => {
  await page.goto("/sign-in");
  await expect(page.getByText("Ask the CEO for a one-time reset link.")).toBeVisible();
  await expect(page.getByRole("complementary", { name: "About Litt’s Loans" }).getByText(/^Private loans, mortgages, collections and commission\./)).toBeVisible();
});

test.describe("CEO", () => {
  test.use({ storageState: statePath("ceo") });

  test("buttons that go somewhere are links, and each page has one filled primary action", async ({ page }) => {
    const watch = watchErrors(page);
    await page.goto("/loans", { waitUntil: "networkidle" });
    await expect(page.getByRole("link", { name: "New loan" })).toBeVisible();
    await expect(page.getByRole("button", { name: "New loan" })).toHaveCount(0);
    await page.getByRole("button", { name: /^New/ }).click();
    const menu = page.getByRole("menu");
    await expect(menu.getByText("Start a deal")).toBeVisible();
    await expect(menu.getByText("Bring in data")).toBeVisible();
    await page.keyboard.press("Escape");
    // Base UI used to warn about every link styled as a button.
    watch.expectNone();
  });

  test("list tabs show their counts, on mortgages as on loans", async ({ page }) => {
    await page.goto("/mortgages", { waitUntil: "networkidle" });
    const tabs = page.getByRole("navigation", { name: "Mortgage status" });
    await expect(tabs.getByRole("link", { name: /^Active \d+$/ })).toHaveAttribute("aria-current", "page");
    await expect(tabs.getByRole("link", { name: /^Not pasted \d+$/ })).toBeVisible();
  });

  test("“Assign loan officers” opens just the loans without one", async ({ page }) => {
    await page.goto("/loans?status=live&officer=unassigned", { waitUntil: "networkidle" });
    await expect(page.getByRole("navigation", { name: "Loan status" }).getByRole("link", { name: /^Active & overdue \d+$/ })).toHaveAttribute("aria-current", "page");
    const rows = page.locator("#results tbody tr");
    for (const row of await rows.all()) await expect(row).toContainText("Unassigned");
  });

  test("a defaulted loan's schedule says which instalments weren't paid", async ({ page }) => {
    // One the data is sure about: no early repayment, instalments due well before the newest bank row.
    if (!process.env.DATABASE_URL) process.loadEnvFile?.(".env.local");
    const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    const { rows } = await db.query<{ id: string }>(`
      select l.id from loan l
       where l.status = 'defaulted' and l.retired_at is null and l.opened_at < (select max(occurred_at) from bank_transaction) - interval '9 days'
         and not exists (select 1 from loan_payment_link k where k.loan_id = l.id and k.role = 'early_principal')
       order by l.opened_at limit 1`);
    await db.end();
    test.skip(!rows[0], "needs a defaulted loan (E2E_SEED=1)");
    await page.goto(`/loans/${rows[0].id}`, { waitUntil: "networkidle" });
    await expect(page.getByText("Not paid", { exact: true }).first()).toBeVisible();
  });

  test("the new-loan form points at the field that's missing", async ({ page }) => {
    await page.goto("/loans/new", { waitUntil: "networkidle" });
    await page.getByLabel("State ID").fill("40001");
    await page.getByLabel("Borrower’s name").fill("Avery Lane");
    await page.getByLabel("Loan amount").fill("50000");
    await page.getByLabel("Weeks").fill("8");
    await page.getByLabel("Interest rate").fill("15");
    await page.getByRole("button", { name: "Issue contract" }).click();
    const field = page.getByLabel("Vehicle make & model");
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await expect(field).toBeFocused();
    await expect(page.getByText("Give the vehicle’s make & model.").first()).toBeVisible();
    await expect(page).toHaveURL(/\/loans\/new$/);
  });
});
