import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { statePath } from "./support";

/**
 * Legal cases (2026-11-10): a defaulted loan's case sheet, filled in, handed to Legal (frozen), and the attorney &
 * filing fee to pay with its referenced comment. Runs on the seeded fixtures; picks any case not yet handed over.
 */

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

test.describe("legal cases", () => {
  test.use({ storageState: statePath("ceo") });

  test("fill in the contract details, hand the case to Legal, and see the fee to pay", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/loans/legal?view=needs_details");
    await expect(page.getByRole("heading", { name: "Legal cases" })).toBeVisible();
    expect((await new AxeBuilder({ page }).withTags(TAGS).analyze()).violations).toEqual([]);

    let rows = page.locator("#results tbody tr");
    if ((await rows.count()) === 0) {
      await page.goto("/loans/legal?view=ready");
      rows = page.locator("#results tbody tr");
    }
    await rows.first().getByRole("link").click();
    await page.waitForURL(/\/loans\/legal\/[0-9a-f-]{36}$/);

    const save = page.getByRole("button", { name: "Save contract details" });
    if (await save.isVisible()) {
      await page.getByLabel("Defaulted Account Fee per day").fill("200");
      await page.getByLabel("Unsecured: no collateral was pledged").check();
      await save.click();
      await expect(page.getByText("Contract details saved.")).toBeVisible();
      // Off the button first: axe would judge its hover colour, and a toast under the pointer never closes.
      await page.mouse.move(0, 0);
      // Scan once the toast and the button's pending state are gone (they animate).
      await expect(page.getByText("Contract details saved.")).toBeHidden({ timeout: 10_000 });
    }
    const sheet = page.getByLabel("case sheet", { exact: true });
    await expect(sheet).toContainText("per day in default");
    await expect(sheet).toContainText(/Defaulted - \w+ \d{1,2}(st|nd|rd|th) \d{4}/);
    expect((await new AxeBuilder({ page }).withTags(TAGS).analyze()).violations).toEqual([]);

    await page.getByRole("button", { name: "Hand to Legal" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("the sheet is fixed at");
    await dialog.getByRole("button", { name: "Hand to Legal" }).click();
    await expect(page.getByText("Handed to Legal.")).toBeVisible();
    await page.mouse.move(0, 0);
    await expect(page.getByText("Handed to Legal.")).toBeHidden({ timeout: 10_000 });

    await expect(page.getByText("With Legal").first()).toBeVisible();
    await expect(page.getByText(/As handed to Legal on/)).toBeVisible();
    const fee = page.getByText(/Attorney & Filing Fee - .+ Default #LC\d+/);
    await expect(fee).toBeVisible();
    await expect(page.getByText("$2,750").first()).toBeVisible();

    await page.getByRole("button", { name: "Copy case sheet" }).click();
    // Windows puts CRLF line endings on the clipboard.
    const copied = (await page.evaluate(() => navigator.clipboard.readText())).split("\r").join("");
    expect(copied).toMatch(/^.+ - \d+\n\n\$[\d,]+ \* \d+ = [\d,]+\n\n/);
    expect((await new AxeBuilder({ page }).withTags(TAGS).analyze()).violations).toEqual([]);
  });

  test("management notes a contract that differs from the game; the sheet keeps the phone card's amount (2026-11-10)", async ({ page }) => {
    // The last case not yet handed over (the test above takes the first).
    await page.goto("/loans/legal?view=needs_details");
    let rows = page.locator("#results tbody tr");
    if ((await rows.count()) < 2) {
      await page.goto("/loans/legal?view=ready");
      rows = page.locator("#results tbody tr");
    }
    await rows.last().getByRole("link").click();
    await page.waitForURL(/\/loans\/legal\/[0-9a-f-]{36}$/);

    // A failed earlier attempt (CI retries) may have left its note on this case: remove it first.
    const change = page.getByRole("button", { name: "Change the contract note" });
    const fresh = page.getByText("From the latest phone card");
    await expect(change.or(fresh)).toBeVisible();
    if (await change.isVisible()) {
      await change.click();
      await page.getByLabel("Why it differs").fill("Left by an earlier test attempt");
      await page.getByRole("button", { name: "Remove the note" }).click();
      await expect(page.getByText("Contract note removed.")).toBeVisible();
    }
    await expect(fresh).toBeVisible();

    await page.getByRole("button", { name: "The contract says a different payment" }).click();
    await page.getByLabel("Weekly payment on the contract").fill("$5,161");
    await page.getByLabel("Why it differs").fill("Contract written at 22%, game set at 21%");
    await page.getByRole("button", { name: "Save note" }).click();
    await expect(page.getByText("Contract note saved.")).toBeVisible();
    await expect(page.getByText("The contract says $5,161 a week")).toBeVisible();
    await expect(page.getByText(/Contract written at 22%, game set at 21%/)).toBeVisible();
    // Off the button first: the toast opens under it, and a toast under the pointer never closes (nightly 2026-11-11).
    await page.mouse.move(0, 0);
    await expect(page.getByText("Contract note saved.")).toBeHidden({ timeout: 10_000 });
    expect((await new AxeBuilder({ page }).withTags(TAGS).analyze()).violations).toEqual([]);

    await page.getByRole("button", { name: "Change the contract note" }).click();
    await page.getByLabel("Why it differs").fill("Paper matches the game after all");
    await page.getByRole("button", { name: "Remove the note" }).click();
    await expect(page.getByText("Contract note removed.")).toBeVisible();
    await expect(page.getByText("From the latest phone card")).toBeVisible();
  });
});

test.describe("legal cases for an officer", () => {
  test.use({ storageState: statePath("loan_officer") });

  test("is in the sidebar and lists only their own cases", async ({ page }) => {
    await page.goto("/my-work");
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Legal cases" }).click();
    await expect(page.getByRole("heading", { name: "Legal cases" })).toBeVisible();
    await expect(page.getByText(/Your defaulted loans going to court/)).toBeVisible();
  });
});
