import { expect, test, type Page } from "@playwright/test";
import { NAMES, statePath } from "./support";

/** The main things people do, end to end in a real browser. */

test.describe("loan officer", () => {
  test.use({ storageState: statePath("loan_officer") });

  test("lands on My work, without the company dashboard", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/my-work$/);
    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav.getByRole("link", { name: "My work" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Dashboard" })).toHaveCount(0);
  });

  test("prices a loan, issues the contract, copies it and cancels the offer", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/loans/new", { waitUntil: "networkidle" });
    await page.getByText("Property loan", { exact: true }).click();
    await page.getByLabel("State ID").fill("40001");
    await page.getByLabel("Borrower’s name").fill("Avery Lane");
    await page.getByLabel("Loan amount").fill("130000");
    await page.getByLabel("Weeks").fill("24");
    await page.getByLabel("Interest rate").fill("15");
    await page.getByLabel("Property address").fill("103 South Rockford Dr");
    await page.getByLabel("Property’s value").fill("200000");
    await page.getByLabel("Borrower’s weekly income").fill("20000");
    // The template's example: $6,229 a week, $149,500 in all.
    await expect(page.getByText("$6,229").first()).toBeVisible();
    await expect(page.getByText("$149,500").first()).toBeVisible();
    await page.getByRole("button", { name: "Issue contract" }).click();
    await page.waitForURL(/\/loans\/offers\/[0-9a-f-]{36}$/);
    const contract = await page.locator("pre").innerText();
    expect(contract).toContain("LITT'S LOANS PROPERTY LOAN AGREEMENT");
    expect(contract).toContain("Repayment Schedule: $6,229 a week");
    // Not paid out yet: the officer can link the loan by hand once the game pays it.
    await expect(page.getByText("Paid out already?")).toBeVisible();
    await expect(page.getByRole("button", { name: "Link a loan…" })).toBeVisible();
    await page.getByRole("button", { name: "Copy contract" }).click();
    expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n")).toBe(contract);
    await page.getByRole("button", { name: "Cancel offer" }).click();
    await page.getByLabel("Reason").fill("E2E test offer");
    await page.getByRole("dialog").getByRole("button", { name: "Cancel offer" }).click();
    await expect(page.getByText("Cancelled", { exact: true }).first()).toBeVisible();
  });

  test("a quote over the federal maximums can't be saved; company-funded is exempt", async ({ page }) => {
    await page.goto("/mortgages/quotes/new", { waitUntil: "networkidle" });
    await page.getByLabel("Buyer’s State ID").fill("40001");
    await page.getByLabel("Buyer’s name").fill("Avery Lane");
    await page.getByLabel("Property address").fill("201 Federal Way");
    await page.getByLabel("Total value").fill("733856");
    await page.getByLabel("Agency commission").fill("44470");
    await page.getByLabel("Term").fill("12");
    // $689,386 down payment + loan: the band up to $1,000,000. An empty banker fee is that band's 5%.
    await expect(page.getByText(/Federal maximums for mortgages up to \$1,000,000/)).toBeVisible();
    await expect(page.getByText("Left empty, it’s 5%.")).toBeVisible();
    const save = page.getByRole("button", { name: "Save quote" });
    await expect(save).toBeEnabled();
    await page.getByLabel("Banker fee").fill("8");
    await expect(page.getByText("Banker fee 8% is above the federal maximum of 5% for mortgages up to $1,000,000")).toBeVisible();
    await expect(page.getByText("Over the federal maximums: this quote can’t be saved.")).toBeVisible();
    await expect(save).toBeDisabled();
    await page.getByLabel("Company-funded").check();
    await expect(page.getByRole("textbox", { name: "Fed rate", exact: true })).toBeDisabled();
    await expect(save).toBeEnabled();
    await page.getByLabel("Company-funded").uncheck();
    await page.getByLabel("Banker fee").fill("5");
    await expect(save).toBeEnabled();
  });

  test("keyboard shortcuts: ? lists them, G then L goes to Loans, and they can be switched off", async ({ page }) => {
    await page.goto("/my-work", { waitUntil: "networkidle" });
    await page.keyboard.press("Shift+Slash");
    const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await page.keyboard.press("g");
    await page.keyboard.press("l");
    await expect(page).toHaveURL(/\/loans$/);
    await page.keyboard.press("Shift+Slash");
    await page.getByLabel("Single-key shortcuts").uncheck();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await page.keyboard.press("g");
    await page.keyboard.press("m");
    await page.waitForTimeout(700);
    await expect(page).toHaveURL(/\/loans$/);
    await page.evaluate(() => localStorage.removeItem("litts.shortcuts"));
  });
});

test("a manager's quote: the team sees it, only the manager changes it", async ({ browser }) => {
  const manager = await browser.newContext({ storageState: statePath("management") });
  const m = await manager.newPage();
  await m.goto("/mortgages/quotes/new", { waitUntil: "networkidle" });
  await m.getByLabel("Buyer’s State ID").fill("33333");
  await m.getByLabel("Buyer’s name").fill("Team Buyer");
  await m.getByLabel("Property address").fill("200 Team Way");
  await m.getByLabel("Total value").fill("500000");
  await m.getByLabel("Agency commission").fill("25000");
  await m.getByLabel("Term").fill("12");
  await expect(m.getByText("State allowance left after this")).toBeVisible();
  await m.getByRole("button", { name: "Save quote" }).click();
  await m.waitForURL(/\/mortgages\/quotes\/[0-9a-f-]{36}$/);
  const quoteUrl = m.url();

  const officer = await browser.newContext({ storageState: statePath("loan_officer") });
  const o = await officer.newPage();
  await o.goto("/mortgages/quotes?status=draft", { waitUntil: "networkidle" });
  await expect(o.locator("#results tbody")).toContainText("200 Team Way");
  await expect(o.locator("#results tbody")).toContainText(NAMES.management);
  await expect(o.getByRole("heading", { name: /^State allowance/ })).toBeVisible();
  await o.goto(quoteUrl, { waitUntil: "networkidle" });
  await expect(o.getByText(/You can see it to help out/)).toBeVisible();
  await expect(o.getByRole("button", { name: "Cancel quote" })).toHaveCount(0);
  await o.goto(`${quoteUrl}/edit`);
  await expect(o).toHaveURL(quoteUrl);

  await m.goto(quoteUrl, { waitUntil: "networkidle" });
  await m.getByRole("button", { name: "Cancel quote" }).click();
  await m.getByLabel("Reason").fill("E2E test quote");
  await m.getByRole("dialog").getByRole("button", { name: "Cancel quote" }).click();
  await expect(m.getByText("Cancelled", { exact: true }).first()).toBeVisible();
  await manager.close();
  await officer.close();
});

test("a large quote: management ask for changes, the officer makes them, an executive approves (research/18)", async ({ browser }) => {
  const officer = await browser.newContext({ storageState: statePath("loan_officer") });
  const manager = await browser.newContext({ storageState: statePath("management") });
  const chief = await browser.newContext({ storageState: statePath("ceo") });
  const o = await officer.newPage();
  const m = await manager.newPage();
  const c = await chief.newPage();

  // $1,250,000 down payment + loan: over the $1,000,000 line.
  await o.goto("/mortgages/quotes/new", { waitUntil: "networkidle" });
  await o.getByLabel("Buyer’s State ID").fill("40001");
  await o.getByLabel("Buyer’s name").fill("Avery Lane");
  await o.getByLabel("Property address").fill("300 Approval Heights");
  await o.getByLabel("Total value").fill("1300000");
  await o.getByLabel("Agency commission").fill("50000");
  await o.getByLabel("Term").fill("12");
  await expect(o.getByText("Over $1,000,000: needs an executive’s approval")).toBeVisible();
  await o.getByRole("button", { name: "Save quote" }).click();
  await o.waitForURL(/\/mortgages\/quotes\/[0-9a-f-]{36}$/);
  const quoteUrl = o.url();
  const n = (await o.getByRole("heading", { level: 1 }).innerText()).replace(/\D/g, "");
  await expect(o.getByText("Waiting for an executive’s approval")).toBeVisible();
  await expect(o.getByText("Terms, waiting for approval", { exact: true })).toBeVisible();
  // Nothing to copy into the tablet yet.
  await expect(o.getByRole("button", { name: /^Copy / })).toHaveCount(0);

  // Management say what needs changing instead of changing it.
  await m.goto(quoteUrl, { waitUntil: "networkidle" });
  await m.getByLabel("What needs changing?").fill("Term should be 10 months for this buyer.");
  await m.getByRole("button", { name: `Send to ${NAMES.loan_officer}` }).click();
  await expect(m.getByText(`${NAMES.management} asked for changes`)).toBeVisible();

  // The officer sees it in the list, the bell and on the edit form.
  await o.goto("/mortgages/quotes?status=draft", { waitUntil: "networkidle" });
  const row = o.locator("#results tbody tr", { hasText: `#${n} ·` });
  await expect(row).toContainText("1 change asked");
  await expect(row).toContainText("Needs approval");
  const bell = o.getByRole("button", { name: /^Notifications/ });
  await expect(bell).toHaveAccessibleName(/^Notifications, \d+ new$/);
  const unread = Number((await bell.getAttribute("aria-label"))!.replace(/\D/g, ""));
  await bell.click();
  await o.getByRole("link", { name: new RegExp(`asked for changes on quote #${n}`) }).click();
  await o.waitForURL(quoteUrl);
  // Read stays read on the next page (it once came back after any client-side navigation).
  const after = unread > 1 ? `Notifications, ${unread - 1} new` : "Notifications";
  await expect(bell).toHaveAccessibleName(after);
  await o.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "My work" }).click();
  await o.waitForURL(/\/my-work$/);
  await expect(bell).toHaveAccessibleName(after);
  await o.goto(`${quoteUrl}/edit`, { waitUntil: "networkidle" });
  await expect(o.getByText("1 change asked for")).toBeVisible();
  await o.getByLabel("Term").fill("10");
  await o.getByRole("button", { name: "Save quote" }).click();
  await o.waitForURL(quoteUrl);
  await o.getByRole("button", { name: "Mark done…" }).click();
  await o.getByLabel("Reply (optional)").fill("Term changed to 10 months");
  await o.getByRole("button", { name: "Mark done", exact: true }).click();
  await expect(o.getByText(`Done by ${NAMES.loan_officer}`)).toBeVisible();

  // The manager hears back.
  await m.goto("/my-work", { waitUntil: "networkidle" });
  await m.getByRole("button", { name: /^Notifications/ }).click();
  await expect(m.getByText(`${NAMES.loan_officer} replied on quote #${n}`)).toBeVisible();

  // An executive approves; the officer can copy the terms into the tablet.
  await c.goto(quoteUrl, { waitUntil: "networkidle" });
  await expect(c.getByText("Needs your approval", { exact: true })).toBeVisible();
  await c.getByRole("button", { name: "Approve quote" }).click();
  await expect(c.getByText(`Approved by ${NAMES.ceo}`)).toBeVisible();
  await o.goto(quoteUrl, { waitUntil: "networkidle" });
  await expect(o.getByText("Enter on the tablet", { exact: true })).toBeVisible();
  await expect(o.getByRole("button", { name: "Copy Loan amount" })).toBeVisible();

  await o.getByRole("button", { name: "Cancel quote" }).click();
  await o.getByLabel("Reason").fill("E2E test quote");
  await o.getByRole("dialog").getByRole("button", { name: "Cancel quote" }).click();
  await expect(o.getByText("Cancelled", { exact: true }).first()).toBeVisible();
  await Promise.all([officer.close(), manager.close(), chief.close()]);
});

test.describe("CEO", () => {
  test.use({ storageState: statePath("ceo") });

  test("borrower directory filters as you type, and / jumps to its search", async ({ page }) => {
    await page.goto("/loans/borrowers", { waitUntil: "networkidle" });
    const before = await page.locator("tbody tr").count();
    expect(before).toBeGreaterThan(5);
    await page.keyboard.press("/");
    await expect(page.locator("[data-list-search]")).toBeFocused();
    await page.keyboard.type("zz-nobody");
    await expect(page).toHaveURL(/q=zz-nobody/);
    await expect(page.getByText("No one found")).toBeVisible();
  });

  test("settings count unsaved changes and discard them", async ({ page }) => {
    await page.goto("/settings", { waitUntil: "networkidle" });
    const field = page.locator("#loans-stateRatePct");
    const original = await field.inputValue();
    // The save bar's label (the history card can also say "No changes yet").
    const bar = page.locator('label[for="settings-reason"]');
    await field.fill(String(Number(original) + 1));
    await expect(bar).toContainText("1 unsaved change");
    await page.getByRole("button", { name: "Discard" }).click();
    await expect(bar).toHaveText("No changes yet");
    await expect(field).toHaveValue(original);
  });

  test("the audit log reads in plain English and links its subjects", async ({ page }) => {
    await page.goto("/audit", { waitUntil: "networkidle" });
    await expect(page.locator("tbody")).not.toContainText(/loans\.offer\.|mortgages\.quote\.|loan_offer|mortgage_quote/);
  });

  test("P&L account names stay put when the months scroll", async ({ page }) => {
    await page.goto("/finance/reports", { waitUntil: "networkidle" });
    const region = page.getByRole("region", { name: "Income" });
    await region.evaluate((el) => (el.scrollLeft = 600));
    const cell = await region.locator("tbody tr").first().locator("td").first().boundingBox();
    const box = await region.boundingBox();
    expect(Math.abs((cell?.x ?? 0) - (box?.x ?? 99))).toBeLessThan(2);
  });
});

/** A datetime-local value (the browser's own zone) for an instant. */
function localInput(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function startQuote(page: Page, address: string, value: string) {
  await page.goto("/mortgages/quotes/new", { waitUntil: "networkidle" });
  await page.getByLabel("Buyer’s State ID").fill("40001");
  await page.getByLabel("Buyer’s name").fill("Avery Lane");
  await page.getByLabel("Property address").fill(address);
  await page.getByLabel("Total value").fill(value);
  await page.getByLabel("Agency commission").fill("25000");
  await page.getByLabel("Term").fill("12");
  await page.getByRole("button", { name: "Save quote" }).click();
  await page.waitForURL(/\/mortgages\/quotes\/[0-9a-f-]{36}$/);
}

async function cancelQuote(page: Page) {
  await page.getByRole("button", { name: "Cancel quote" }).click();
  await page.getByLabel("Reason").fill("E2E test quote");
  await page.getByRole("dialog").getByRole("button", { name: "Cancel quote" }).click();
  await expect(page.getByText("Cancelled", { exact: true }).first()).toBeVisible();
}

test("a confirmed quote draws on the allowance on its signing day (research/19)", async ({ browser }) => {
  const stamp = Date.now().toString().slice(-6);
  const manager = await browser.newContext({ storageState: statePath("management") });
  const officer = await browser.newContext({ storageState: statePath("loan_officer") });
  const m = await manager.newPage();
  const o = await officer.newPage();

  // Management record a reading (always, with a note that says whose it is).
  await m.goto("/finance/allowance", { waitUntil: "networkidle" });
  await m.getByLabel("State Allowance Balance").fill("$1,000,000");
  await m.getByLabel("Note (optional)").fill(`E2E reading ${stamp}`);
  await m.getByRole("button", { name: "Record reading" }).click();
  await expect(m.getByText("Reading recorded.").first()).toBeVisible();

  const address = `${stamp} Signing Court`;
  await startQuote(o, address, "525000");
  const quoteUrl = o.url();
  const n = (await o.getByRole("heading", { level: 1 }).innerText()).replace(/\D/g, "");
  await o.getByRole("button", { name: "Confirm — buyer is going ahead" }).click();
  const dialog = o.getByRole("dialog");
  await dialog.getByLabel("Expected signing: when the bidding closes").fill(localInput(Date.now() + 2 * 86_400_000));
  await expect(dialog.getByText("Allowance just before signing")).toBeVisible();
  await dialog.getByRole("button", { name: /^Confirm( anyway)?$/ }).click();
  await expect(o.getByRole("button", { name: "Back to draft" })).toBeVisible();

  await o.goto("/mortgages/quotes?status=confirmed", { waitUntil: "networkidle" });
  const row = o.locator("#results tbody tr", { hasText: address });
  await expect(row).toContainText(/Fits|Tight|Short/);
  await expect(o.locator('svg[role="img"]:visible')).toContainText(`#${n} signs`);

  // Changing the figures sends a confirmed quote back to Draft.
  await o.goto(`${quoteUrl}/edit`, { waitUntil: "networkidle" });
  // Focus first: a money field shows "525,000" until it is focused, and filling it mid-switch mangles the digits.
  await o.getByLabel("Total value").click();
  await o.getByLabel("Total value").fill("505000");
  await o.getByRole("button", { name: "Save quote" }).click();
  await o.waitForURL(quoteUrl);
  await expect(o.getByText("Draft", { exact: true }).first()).toBeVisible();
  await expect(o.getByRole("button", { name: "Confirm — buyer is going ahead" })).toBeVisible();
  await cancelQuote(o);
  await Promise.all([manager.close(), officer.close()]);
});

test("a signing time typed in New York is stored as that instant and shown in the viewer's zone (research/19)", async ({ browser }) => {
  const stamp = Date.now().toString().slice(-6);
  const address = `${stamp} Zone Street`;
  const ny = await browser.newContext({ storageState: statePath("loan_officer"), timezoneId: "America/New_York" });
  const p = await ny.newPage();
  await startQuote(p, address, "500000");
  const quoteUrl = p.url();
  await p.getByRole("button", { name: "Confirm — buyer is going ahead" }).click();
  const dialog = p.getByRole("dialog");
  // 15 January next year: always in the future (a fixed past date disables Confirm), and New York is on EST then.
  const year = new Date().getUTCFullYear() + 1;
  const instant = `${year}-01-15T23:00:00.000Z`;
  const weekday = new Date(instant).toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" });
  await dialog.getByLabel("Expected signing: when the bidding closes").fill(`${year}-01-15T18:00`);
  await dialog.getByRole("button", { name: /^Confirm( anyway)?$/ }).click();
  await expect(p.getByRole("button", { name: "Back to draft" })).toBeVisible();
  // 18:00 in New York (UTC−5 in January) is 23:00Z.
  await expect(p.locator(`time[datetime="${instant}"]`).first()).toBeVisible();

  const uk = await browser.newContext({ storageState: statePath("loan_officer"), timezoneId: "Europe/London" });
  const u = await uk.newPage();
  await u.goto(quoteUrl, { waitUntil: "networkidle" });
  const t = u.locator(`time[datetime="${instant}"]`).first();
  await expect(t).toBeVisible();
  await expect(t).toContainText("23:00");

  // The allowance chart is in the viewer's zone too, once hydrated (owner, 2026-10-20).
  await p.goto("/mortgages/quotes?status=confirmed", { waitUntil: "networkidle" });
  await expect(p.getByText("Chart times are your time (America/New_York).")).toBeVisible();
  await p.getByText("Show as table").click();
  await expect(p.getByRole("rowheader", { name: new RegExp(`signs · ${address}`) })).toBeVisible();
  await expect(p.getByRole("row", { name: new RegExp(`signs · ${address}`) })).toContainText(`${weekday} 15 Jan, 18:00`);

  await p.goto(quoteUrl);
  await cancelQuote(p);
  await Promise.all([ny.close(), uk.close()]);
});
