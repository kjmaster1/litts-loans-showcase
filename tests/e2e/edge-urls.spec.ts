import { expect, test } from "@playwright/test";
import { statePath } from "./support";

/**
 * Hostile and odd URLs (QA 2026-10-11 found NUL bytes and overlong numbers crashing
 * searches): every one must answer below 500 with no page error and no raw error text.
 */
const URLS = [
  "/loans?sort=__proto__&dir=constructor",
  "/loans?status=../../etc",
  "/loans?q=%25%27%22<b>",
  `/loans?q=${"x".repeat(500)}`,
  "/loans?q=%00",
  "/loans?q=99999999999",
  "/loans?officer=not-a-uuid",
  "/mortgages?status=__proto__",
  "/mortgages?q=%00",
  "/mortgages?q=99999999999",
  "/loans/borrowers?q=%00",
  "/loans/borrowers?q=99999999999",
  "/loans/borrowers?sort=__proto__",
  "/loans/borrowers/99999999999",
  "/loans/borrowers/abc",
  "/loans/borrowers?stateId=12&amount=-5&rate=abc",
  "/loans/not-a-uuid",
  "/loans/00000000-0000-0000-0000-000000000000",
  "/mortgages/xyz",
  "/loans/offers?status=__proto__&who=x",
  "/loans/offers/xyz",
  "/loans/new?offer=xyz",
  "/loans/new?stateId=<script>",
  "/mortgages/quotes/xyz",
  "/mortgages/quotes/xyz/edit",
  "/mortgages/quotes?status=__proto__",
  "/finance/transactions?page=-1",
  "/finance/transactions?page=99999",
  "/finance/transactions?q=%00",
  "/finance/transactions?category=__proto__&direction=sideways",
  "/finance/transactions/xyz",
  "/finance/ledger/9999",
  "/finance/reports?report=__proto__",
  "/finance/reports?from=2026-13-45&to=1900-01-01",
  "/finance/reports?from=2030-01-01&to=2020-01-01",
  "/finance/imports/xyz",
  "/commissions/2026-W99",
  "/commissions/__proto__",
  "/audit?category=constructor",
  "/audit?before=abc",
  "/audit?before=99999999999999999999999",
  "/staff?q=%00",
];

test.use({ storageState: statePath("ceo") });

test("odd URLs never crash a page", async ({ page }) => {
  test.setTimeout(10 * 60_000);
  const problems: string[] = [];
  let current = "";
  page.on("pageerror", (e) => problems.push(`pageerror @ ${current}: ${e.message}`));
  for (const u of URLS) {
    current = u;
    const res = await page.goto(u, { waitUntil: "networkidle" });
    const status = res?.status() ?? 0;
    if (status >= 500) problems.push(`${status} @ ${u}`);
    const text = await page.locator("body").innerText();
    if (/Application error|This page couldn’t load|The server returned an error|\bNaN\b|\[object Object\]|Invalid Date/.test(text)) problems.push(`error text @ ${u}`);
  }
  expect(problems, problems.join("\n")).toEqual([]);
});

test("the search palette copes with odd input", async ({ page }) => {
  await page.goto("/loans", { waitUntil: "networkidle" });
  for (const q of ["99999999999", "50%", "a_b", "__proto__"]) {
    await page.keyboard.press("Control+k");
    const dialog = page.getByRole("dialog", { name: "Search" });
    await dialog.getByRole("combobox").fill(q);
    await page.waitForTimeout(800);
    await expect(dialog).not.toContainText(/went wrong/i);
    await page.keyboard.press("Escape");
  }
});
