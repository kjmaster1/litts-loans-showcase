import { expect, test } from "@playwright/test";
import { statePath } from "./support";

/**
 * Change name (2026-11-02): a character renamed in the game is renamed on the Staff page; the State ID stays, and the
 * audit log records it.
 */

test.describe("CEO", () => {
  test.use({ storageState: statePath("ceo") });

  test("renames a staff member from their row's menu", async ({ page }) => {
    const stateId = String(70_000 + Math.floor(Math.random() * 20_000));
    const before = `Rename Before ${stateId}`;
    const after = `Rename After ${stateId}`;

    await page.goto("/staff", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Invite staff" }).click();
    await page.getByLabel("Character name").fill(before);
    await page.getByLabel("State ID").fill(stateId);
    await page.getByRole("button", { name: "Create invite link" }).click();
    await expect(page.getByRole("heading", { name: `Invite ready for ${before}` })).toBeVisible();
    await page.getByRole("button", { name: "Done" }).click();

    await page.getByRole("button", { name: `Actions for ${before}` }).click();
    await page.getByRole("menuitem", { name: "Change name…" }).click();
    const dialog = page.getByRole("dialog", { name: `Change name: ${before}` });
    const field = dialog.getByLabel("Character name");
    await expect(field).toHaveValue(before);
    const submit = dialog.getByRole("button", { name: "Change name" });
    await expect(submit).toBeDisabled(); // unchanged
    await field.fill(after);
    await submit.click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(`${before} is now ${after}.`)).toBeVisible();

    const row = page.getByRole("row").filter({ hasText: stateId });
    await expect(row).toContainText(after);
    await expect(row).not.toContainText(before);

    await page.goto("/audit", { waitUntil: "networkidle" });
    await expect(page.getByText("Changed name").first()).toBeVisible();
  });
});
