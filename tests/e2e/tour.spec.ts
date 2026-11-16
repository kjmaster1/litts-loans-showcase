import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { accounts, statePath, watchErrors, type E2eRole } from "./support";

/**
 * The app tour (docs/design/TUTORIAL-2026-10-12.md): offered once, worded for the role, a
 * spotlight per part of the app, pages open behind it, remembered when finished or skipped,
 * restartable from the account menu, and a short "what's new" after a promotion.
 */

async function setTour(role: E2eRole, completed: boolean, touredAs: string | null = null) {
  if (!process.env.DATABASE_URL) process.loadEnvFile?.(".env.local");
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    await db.query(`update staff set tour_completed_at = ${completed ? "now()" : "null"}, tour_role = $2 where state_id = $1`, [accounts()[role].stateId, touredAs]);
  } finally {
    await db.end();
  }
}

async function tourState(role: E2eRole) {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    const { rows } = await db.query<{ done: boolean; as: string | null }>("select tour_completed_at is not null as done, tour_role as as from staff where state_id = $1", [accounts()[role].stateId]);
    return rows[0];
  } finally {
    await db.end();
  }
}

const card = (page: Page) => page.locator("[data-tour-card]");

test.describe("loan officer", () => {
  test.use({ storageState: statePath("loan_officer") });
  test.beforeEach(() => setTour("loan_officer", false));
  test.afterAll(() => setTour("loan_officer", true, "loan_officer"));

  test("first visit: a welcome, then a stop for each part of the app they can use", async ({ page }) => {
    const watch = watchErrors(page);
    await page.goto("/my-work", { waitUntil: "networkidle" });
    const welcome = page.getByRole("dialog", { name: /^Welcome, / });
    await expect(welcome).toBeVisible();
    await expect(welcome).toContainText("You’re signed in as Loan Officer.");
    await expect(welcome.getByRole("listitem")).toHaveText([/Your day/, /Loans, mortgages and borrowers/, /Money/, /Always at the top/, /Your account/]);
    await page.getByRole("button", { name: "Start the tour" }).click();

    // Their own work only: no company dashboard, no books, no admin.
    await expect(page.getByRole("dialog", { name: "Your day" })).toContainText("Step 1 of 5");
    await expect(card(page)).not.toContainText("Dashboard");
    // A name opens its page behind the tour, which carries on.
    await card(page).getByRole("button", { name: "Collections" }).click();
    await expect(page).toHaveURL(/\/loans\/collections$/);
    await expect(page.getByRole("dialog", { name: "Your day" })).toBeVisible();
    // A click on the dimmed page doesn't end it.
    await page.mouse.click(900, 600);
    await expect(page.getByRole("dialog", { name: "Your day" })).toBeVisible();

    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("dialog", { name: "Loans, mortgages and borrowers" })).toBeVisible();
    for (const name of ["Money", "Always at the top", "Your account"]) {
      await page.getByRole("button", { name: "Next" }).click();
      await expect(page.getByRole("dialog", { name })).toBeVisible();
    }
    await expect(card(page)).not.toContainText("Finance");
    await page.getByRole("button", { name: "Finish" }).click();
    await expect(page.getByRole("dialog", { name: "End of the tour" })).toBeVisible();
    await expect.poll(() => tourState("loan_officer")).toEqual({ done: true, as: "loan_officer" });
    await page.getByRole("link", { name: "Price your first loan" }).click();
    await expect(page).toHaveURL(/\/loans\/new$/);
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // Not offered again; the account menu starts it.
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: /Account menu/ }).click();
    await page.getByRole("menuitem", { name: "Take the tour" }).click();
    await expect(page.getByRole("dialog", { name: "Your day" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    watch.expectNone();
  });

  test("“Not now” is remembered", async ({ page }) => {
    await page.goto("/my-work", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Not now" }).click();
    await expect(page.getByText("You can take the tour any time from your account menu.")).toBeVisible();
    await expect.poll(() => tourState("loan_officer")).toEqual({ done: true, as: "loan_officer" });
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("on a phone the sidebar stops point at the menu button", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/my-work", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Start the tour" }).click();
    await expect(card(page)).toContainText("Tap the highlighted menu button");
    await expect(card(page)).toContainText("Tap a name");
    for (let i = 0; i < 4; i++) await page.getByRole("button", { name: "Next" }).click();
    await expect(page.getByRole("dialog", { name: "Your account" })).not.toContainText("Shortcuts");
    await expect(card(page)).toBeInViewport({ ratio: 1 });
  });
});

test.describe("CEO", () => {
  test.use({ storageState: statePath("ceo") });
  test.afterAll(() => setTour("ceo", true, "ceo"));

  test("an executive's tour covers the books, staff, settings and the audit log — and passes axe", async ({ page }) => {
    await setTour("ceo", false);
    await page.goto("/", { waitUntil: "networkidle" });
    const problems: string[] = [];
    const scan = async (label: string) => {
      for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        // Buttons fade their colours (transition-all): axe sampled mid-fade reports a false contrast failure.
        await page.waitForTimeout(600);
        const r = await new AxeBuilder({ page }).include("[data-tour-card]").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
        for (const v of r.violations) problems.push(`${label} (${scheme}): ${v.id} — ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
      }
    };
    await scan("welcome");
    await page.getByRole("button", { name: "Start the tour" }).click();
    await expect(page.getByRole("dialog", { name: "Your day" })).toContainText("Dashboard");
    await scan("step");
    for (const name of ["Loans, mortgages and borrowers", "Money", "Running the company"]) {
      await page.getByRole("button", { name: "Next" }).click();
      await expect(page.getByRole("dialog", { name })).toBeVisible();
    }
    await expect(card(page)).toContainText("one-time reset link");
    await expect(card(page)).toContainText("Audit log");
    await page.getByRole("button", { name: "Next" }).click();
    await expect(card(page)).toContainText("import a bank export");
    await page.getByRole("button", { name: "Next" }).click();
    await expect(card(page)).toContainText("authenticator code");
    await expect(page.getByRole("button", { name: "Skip tour" })).toHaveCount(0);
    await page.getByRole("button", { name: "Finish" }).click();
    // On the dashboard already, so the first suggestion is somewhere else.
    await expect(page.getByRole("link", { name: "Open the books" })).toBeVisible();
    await scan("finish");
    expect(problems, problems.join("\n")).toEqual([]);
  });
});

test.describe("management, after a promotion", () => {
  test.use({ storageState: statePath("management") });
  test.afterAll(() => setTour("management", true, "management"));

  test("shows only what the new role adds", async ({ page }) => {
    await setTour("management", true, "loan_officer");
    await page.goto("/", { waitUntil: "networkidle" });
    await expect(page.getByRole("dialog", { name: "You’re now Management" })).toBeVisible();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Your day" })).toContainText("What’s new 1 of");
    await expect(card(page)).toContainText("Dashboard");
    // Unchanged for the new role: not repeated.
    await page.getByRole("button", { name: "Next" }).click();
    await expect(card(page)).not.toContainText("Borrowers");
    await page.keyboard.press("Escape");
    await expect.poll(() => tourState("management")).toEqual({ done: true, as: "management" });
  });
});
