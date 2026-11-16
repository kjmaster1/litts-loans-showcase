import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import * as XLSX from "xlsx";
import { statePath } from "./support";

/**
 * A renamed customer (QA 2026-10-13, "Later the same day"): the export shows a person's current name on their old
 * rows, and a rename once imported two rows a second time. Only previews here — nothing is ever confirmed.
 */

const ADDRESS = "118 Imagination Ct";
const COL = { amount: 2, name: 6, stateId: 7, comment: 8 };

function exportWith(edit: (rows: unknown[][]) => unknown[][]): Buffer {
  const wb = XLSX.read(readFileSync("tests/fixtures/bank-export.xlsx"), { type: "buffer" });
  const grid = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, blankrows: true, defval: null });
  const buyerRows = grid.slice(6).filter((r) => typeof r[COL.comment] === "string" && (r[COL.comment] as string).startsWith(ADDRESS) && r[COL.stateId] !== 101);
  const out = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(out, XLSX.utils.aoa_to_sheet([...grid.slice(0, 6), ...edit(buyerRows)]), wb.SheetNames[0]);
  return XLSX.write(out, { type: "buffer", bookType: "xlsx" });
}

async function seeded(): Promise<boolean> {
  if (!process.env.DATABASE_URL) process.loadEnvFile?.(".env.local");
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    const { rows } = await db.query(`select 1 from bank_transaction where comment like $1 limit 1`, [`${ADDRESS}:%`]);
    return rows.length > 0;
  } finally {
    await db.end();
  }
}

async function previewOf(page: Page, name: string, buffer: Buffer) {
  await page.goto("/finance/imports");
  await page.locator('input[type="file"]').setInputFiles({ name, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer });
  await page.getByRole("button", { name: "Check file" }).click();
  await page.waitForURL(/\/finance\/imports\/preview\//);
}

test.describe("CEO", () => {
  test.use({ storageState: statePath("ceo") });

  test.beforeEach(async () => {
    test.skip(!(await seeded()), "needs the fixture export imported (E2E_SEED=1)");
  });

  test("a customer's old rows under a new name are recognised as already imported", async ({ page }) => {
    await previewOf(page, "renamed.xlsx", exportWith((rows) => rows.map((r) => r.map((c, i) => (i === COL.name ? "Renamed Buyer" : c)))));
    await expect(page.getByRole("button", { name: "Nothing new to import" })).toBeDisabled();
    await expect(page.getByText(/older than rows already in the books/)).toHaveCount(0);
    await page.getByRole("button", { name: /Discard/ }).click();
  });

  test("a new row dated in the past, and a balance that won't match, are shown in red", async ({ page }) => {
    await previewOf(
      page,
      "backdated.xlsx",
      exportWith((rows) => [rows[0].map((c, i) => (i === COL.comment ? "A payment nobody imported" : i === COL.amount ? 1234 : c))]),
    );
    await expect(page.getByText("1 new row is older than rows already in the books")).toBeVisible();
    await expect(page.getByRole("listitem").filter({ hasText: "A payment nobody imported" })).toBeVisible();
    await expect(page.getByText(/The books won’t match the bank/)).toBeVisible();
    // A warning only: the import can still go ahead.
    await expect(page.getByRole("button", { name: "Confirm import" })).toBeEnabled();
    await page.getByRole("button", { name: /Discard/ }).click();
  });
});
