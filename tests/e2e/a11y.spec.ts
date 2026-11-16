import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { statePath } from "./support";

/**
 * axe-core on the main pages, light and dark: WCAG 2.0–2.2 A/AA *and* best practice (the
 * landmark problems of 2026-10-11 were best-practice rules). Plus the skip link and landmarks.
 */
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

async function firstLink(page: Page, path: string, selector = "tbody a"): Promise<string | null> {
  await page.goto(path, { waitUntil: "networkidle" });
  return page.locator(selector).first().getAttribute("href").catch(() => null);
}

async function scan(page: Page, label: string, problems: string[]) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    // Colours fade (transition-all): axe sampled mid-fade reports a false contrast failure.
    await page.waitForTimeout(600);
    const r = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    for (const v of r.violations) problems.push(`${label} (${scheme}): ${v.id} — ${v.nodes.map((n) => n.target.join(" ")).slice(0, 2).join(" | ")}`);
  }
  await page.emulateMedia({ colorScheme: "light" });
}

test.describe("as the CEO", () => {
  test.use({ storageState: statePath("ceo") });

  test("main pages have no accessibility violations", async ({ page }) => {
    test.setTimeout(20 * 60_000);
    const pages = [
      "/", "/my-work", "/loans/collections", "/loans", await firstLink(page, "/loans"), "/loans/new", "/loans/offers",
      "/mortgages", await firstLink(page, "/mortgages"), "/mortgages/quotes", "/mortgages/quotes/new",
      "/loans/borrowers", await firstLink(page, "/loans/borrowers"), "/finance", "/finance/transactions", "/finance/reports",
      "/finance/allowance", "/commissions", "/staff", "/settings", "/audit", "/account/security",
    ].filter((p): p is string => Boolean(p));
    const problems: string[] = [];
    for (const p of pages) {
      await page.goto(p, { waitUntil: "networkidle" });
      await scan(page, p, problems);
    }
    // Dialogs too: search and keyboard shortcuts.
    await page.goto("/loans", { waitUntil: "networkidle" });
    await page.keyboard.press("Control+k");
    await page.getByRole("dialog", { name: "Search" }).waitFor();
    await scan(page, "search palette", problems);
    await page.keyboard.press("Escape");
    // Shortcuts are ignored while the cursor is still in the closing search box.
    await page.getByRole("dialog", { name: "Search" }).waitFor({ state: "detached" });
    await page.keyboard.press("Shift+Slash");
    await page.getByRole("dialog", { name: "Keyboard shortcuts" }).waitFor();
    await scan(page, "shortcuts dialog", problems);
    expect(problems, problems.join("\n")).toEqual([]);
  });

  test("one main landmark, and Skip to content lands on the page title", async ({ page }) => {
    await page.goto("/loans", { waitUntil: "networkidle" });
    await expect(page.locator("main")).toHaveCount(1);
    await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => document.activeElement?.querySelector("h1")?.textContent)).toBe("Loans");
  });
});

test.describe("on a phone", () => {
  test.use({ storageState: statePath("ceo"), viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("no page scrolls sideways at 390 px", async ({ page }) => {
    for (const p of ["/", "/loans", "/mortgages/quotes", "/loans/borrowers", "/settings", "/finance/reports", "/my-work"]) {
      await page.goto(p, { waitUntil: "networkidle" });
      expect(await page.evaluate(() => document.documentElement.scrollWidth), p).toBeLessThanOrEqual(390);
    }
  });

  test("the allowance chart fits the phone, last day included", async ({ page }) => {
    await page.goto("/mortgages/quotes", { waitUntil: "networkidle" });
    // The compact drawing is the one shown; the wide one is display: none.
    const chart = page.locator('svg[role="img"][data-variant="compact"]');
    await expect(chart).toBeVisible();
    await expect(page.locator('svg[role="img"][data-variant="wide"]')).toBeHidden();
    const box = (await chart.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    const last = (await chart.locator("[data-day-tick]").last().boundingBox())!;
    expect(last.x + last.width).toBeLessThanOrEqual(390);
    expect(last.height).toBeGreaterThanOrEqual(9); // legible text, not a shrunken wide chart
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});
