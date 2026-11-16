import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { statePath } from "./support";

/**
 * QA 2026-10-13: the same Active-tab text pasted 1 h 45 m apart made the phone's countdowns ("in 23 hours") count from
 * the second paste. The preview now says when a tab is the same text as last time although its countdowns should
 * have moved. Only previews here — nothing is saved.
 */

async function withDb<T>(fn: (db: pg.Client) => Promise<T>): Promise<T> {
  if (!process.env.DATABASE_URL) process.loadEnvFile?.(".env.local");
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

test.describe("CEO", () => {
  test.use({ storageState: statePath("ceo") });

  test("pasting the Active tab's last text again, hours later, is flagged as an old copy", async ({ page }) => {
    // The last Active paste must be the fixture's text; make it two hours old.
    const text = readFileSync("tests/fixtures/paste-active.txt", "utf8");
    const last = await withDb(async (db) => {
      const { rows } = await db.query<{ id: string; raws: string[] }>(`
        select p.id, array_agg(c.raw order by c.position) as raws from loan_paste p join loan_card c on c.paste_id = p.id
         where p.id = (select id from loan_paste where tab = 'active' order by captured_at desc limit 1) group by p.id`);
      return rows[0];
    });
    test.skip(!last || !last.raws.every((r) => text.includes(r)), "needs the fixture's Active tab as the last paste (E2E_SEED=1)");
    await withDb((db) => db.query(`update loan_paste set captured_at = captured_at - interval '2 hours' where id = $1`, [last!.id]));

    await page.goto("/loans/import");
    await page.getByRole("radio", { name: "Active" }).click();
    await page.getByLabel("Tab contents").fill(text);
    await page.getByRole("button", { name: "Preview" }).click();
    await expect(page.getByText(/Same text as the Active tab pasted/)).toBeVisible();
    await expect(page.getByText(/Open the tab on the phone and copy it again/)).toBeVisible();
  });
});
