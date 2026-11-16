import { expect, test } from "@playwright/test";
import pg from "pg";
import { statePath } from "./support";

/**
 * Houses renumbered by the server (2026-10-28). In the fixture export #12197's down payment is under
 * 119 West Mirror Drive and her repayment under 112 West Mirror Drive: the import links it by who paid and the
 * mortgage takes the new address, keeping the old one.
 */

async function seeded(): Promise<boolean> {
  if (!process.env.DATABASE_URL) process.loadEnvFile?.(".env.local");
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    const { rows } = await db.query(`select 1 from mortgage where buyer_state_id = 12197 and '119 West Mirror Drive' = any(address_aliases) limit 1`);
    return rows.length > 0;
  } finally {
    await db.end();
  }
}

test.describe("CEO", () => {
  test.use({ storageState: statePath("ceo") });

  test.beforeEach(async () => {
    test.skip(!(await seeded()), "needs the fixture export imported (E2E_SEED=1)");
  });

  test("a mortgage is found by its former address and shows how it changed", async ({ page }) => {
    await page.goto("/mortgages?status=all&q=119%20West%20Mirror", { waitUntil: "networkidle" });
    await page.getByRole("link", { name: "112 West Mirror Drive" }).click();
    await page.waitForURL(/\/mortgages\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("112 West Mirror Drive");
    await expect(page.getByText(/formerly 119 West Mirror Drive/)).toBeVisible();
    await expect(page.getByText("Address changed in the game")).toBeVisible();
    await expect(page.getByText("From 119 West Mirror Drive to 112 West Mirror Drive: the buyer’s repayment came in under the new address")).toBeVisible();
  });
});
