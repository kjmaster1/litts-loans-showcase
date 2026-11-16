import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { totp } from "../support/totp";
import { accounts, statePath, watchErrors } from "./support";

/**
 * Data-quality safeguards (2026-10-12): a tablet paste copied from the heading down became a
 * mortgage called "Sale Agreement - Financed". The preview now skips the heading, refuses
 * incomplete new records and holds possible duplicates; Management+ merges a duplicate on its
 * page (step-up + reason).
 */

const SAMPLE = readFileSync("tests/fixtures/paste-mortgage.txt", "utf8");
const HEADING = "Sale Agreement - Financed\nPROPERTIES\nPAYMENTS\n";
const collapsed = (text: string) => text.replace(/Loan details\r?\n[\s\S]*?(?=Agency commission)/, "Loan details\n");

type Target = { id: string; address: string; buyer_state_id: number; buyer_name: string | null; price_cents: string };
let target: Target | undefined;
let junkId: string | undefined;

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

  test.beforeAll(async () => {
    // A real, banked mortgage to duplicate, and (as made before the safeguards) a junk copy of it.
    await withDb(async (db) => {
      const { rows } = await db.query<Target>(
        `select id, address, buyer_state_id, buyer_name, price_cents from mortgage
          where merged_into_id is null and origination_tx_id is not null and buyer_state_id is not null and price_cents is not null
          order by originated_at desc limit 1`,
      );
      target = rows[0];
      if (!target) return;
      const junk = await db.query<{ id: string }>(
        `insert into mortgage (address, buyer_state_id, buyer_name, price_cents, instalments, funding, last_tablet_at)
         values ('Sale Agreement - Financed', $1, $2, $3, 5, 'company', now()) returning id`,
        [target.buyer_state_id, target.buyer_name, target.price_cents],
      );
      junkId = junk.rows[0].id;
    });
  });

  test("the tablet preview skips the heading, refuses an incomplete paste and holds a possible duplicate", async ({ page }) => {
    test.skip(!target, "needs a mortgage with bank money (E2E_SEED=1)");
    const watch = watchErrors(page);
    await page.goto("/mortgages/import", { waitUntil: "networkidle" });

    // Copied from the heading down, with Loan details closed, for a buyer Litt's doesn't know.
    const incomplete = HEADING + collapsed(SAMPLE.replace("117 Invention Ct", "998 E2E Incomplete Rd").replace(/#1632 [^\n]+/, "#7777001 E2E Nobody"));
    await page.getByLabel("Agreement text").fill(incomplete);
    await page.getByRole("button", { name: "Preview" }).click();
    await expect(page.getByText("Left out above the address: “Sale Agreement - Financed”, “PROPERTIES”, “PAYMENTS”")).toBeVisible();
    await expect(page.getByText("Can’t be saved")).toBeVisible();
    await expect(page.getByText(/Open “Loan details” on the tablet/)).toBeVisible();
    await expect(page.getByRole("button", { name: /Save 0 agreements/ })).toBeDisabled();
    await page.getByRole("button", { name: "Back" }).click();

    // Same buyer and price as a mortgage already on file, at an address nobody has: someone must choose.
    const price = `$${(Number(target!.price_cents) / 100).toLocaleString("en-US")}`;
    const duplicate = SAMPLE.replace("117 Invention Ct", "999 E2E Duplicate Rd")
      .replace("$733,856", price)
      .replace(/#1632 [^\n]+/, `#${target!.buyer_state_id} ${target!.buyer_name ?? "Buyer"}`);
    await page.getByLabel("Agreement text").fill(duplicate);
    await page.getByRole("button", { name: "Preview" }).click();
    await expect(page.getByText("Possible duplicate", { exact: true })).toBeVisible();
    await expect(page.getByText(/the possible duplicate is first/)).toBeVisible();
    await expect(page.getByRole("button", { name: /Save 0 agreements/ })).toBeDisabled();
    await page.getByRole("radio", { name: new RegExp(`Update ${target!.address}`) }).check();
    await expect(page.getByRole("button", { name: /Save 1 agreement/ })).toBeEnabled();
    await page.getByRole("radio", { name: "Skip this agreement" }).check();
    await expect(page.getByText(/the possible duplicate is first/)).toHaveCount(0);
    watch.expectNone();
  });

  test("a duplicate mortgage is merged into the real one, with a step-up and a reason", async ({ page }) => {
    test.skip(!target || !junkId, "needs a mortgage with bank money (E2E_SEED=1)");
    const watch = watchErrors(page);
    await page.goto(`/mortgages/${junkId}`, { waitUntil: "networkidle" });
    await expect(page.getByText("This doesn’t look like a real mortgage record")).toBeVisible();
    await page.getByRole("button", { name: "Merge…" }).click();
    await page.getByLabel(/Merge “Sale Agreement - Financed” into/).click();
    await page.getByRole("option", { name: new RegExp(`^${target!.address} · .*same buyer`) }).click();
    await page.getByLabel("Reason").fill("E2E: pasted from the tablet heading by mistake");
    await page.getByRole("button", { name: "Merge", exact: true }).click();

    const dialog = page.getByRole("dialog", { name: /Confirm it/ });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Authentication code").fill(totp(accounts().ceo.secret));
    await page.waitForURL(`**/mortgages/${target!.id}`);
    await expect(page.getByText(`Merged into ${target!.address}.`)).toBeVisible();
    await expect(page.getByText("Duplicate record merged in").first()).toBeVisible();

    // Old links to the duplicate now land on the real record.
    await page.goto(`/mortgages/${junkId}`);
    await expect(page).toHaveURL(new RegExp(`/mortgages/${target!.id}$`));
    watch.expectNone();
  });
});
