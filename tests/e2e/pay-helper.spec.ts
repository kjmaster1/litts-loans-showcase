import { expect, type Page, test } from "@playwright/test";
import { phoneList } from "../../src/lib/pay-helper";
import { statePath } from "./support";

/**
 * The phone helper (2026-11-02): the bookmarklet copied from the Commissions page fills the phone's Pay Employee form
 * from the pay sheet's list and ticks a person off when Submit is pressed. The phone is a stand-in with the real
 * page's structure (label `span` + `input` under one parent, Cancel/Submit buttons, the card's number in a `span`) and,
 * since 2026-11-16, Pay Employee's Employee dropdown with the State ID box labelled "... or State ID".
 */

const PHONE = "https://phone.litts.test/";
const field = (label: string) => `<div><div><span>${label}</span></div><input type="text"></div>`;
// Since 2026-11-16 Pay Employee opens with an Employee dropdown above "... or State ID"; the helper leaves it alone.
const EMPLOYEE = `<div><div><span>Employee</span></div><div role="combobox"><span>Select Employee</span></div></div>`;
// The helper sits top left; the real phone is on the right of the page.
const PHONE_HTML = `<!doctype html><html><body style="margin-left:440px">
<span>69811362</span>
<button id="open-pay">Pay Employee</button> <button id="open-transfer">Transfer</button>
<div id="sheet"></div>
<script>
  window.submitted = [];
  const sheet = document.getElementById("sheet");
  function open(fields) {
    sheet.innerHTML = '<div><div>' + fields + '</div><div><button type="submit">Cancel</button><button type="submit">Submit</button></div></div>';
    const [cancel, submit] = sheet.querySelectorAll("button");
    cancel.onclick = () => (sheet.innerHTML = "");
    submit.onclick = () => {
      window.submitted.push([...sheet.querySelectorAll("input")].map((i) => i.value));
      sheet.innerHTML = "";
    };
  }
  document.getElementById("open-pay").onclick = () => open(${JSON.stringify(EMPLOYEE + field("... or State ID") + field("Amount") + field("Comment"))});
  document.getElementById("open-transfer").onclick = () =>
    open(${JSON.stringify(field("State ID") + field("... or Wallet ID") + field("Amount") + field("Comment"))});
</script></body></html>`;

const LIST = phoneList([
  { name: "Avery Lane", stateId: 40001, owedCents: 123_400, comment: "[COMM] Commission Pay: w/c 26 Oct" },
  { name: "Jax Chaplan", stateId: 515151, owedCents: 97_100, comment: "[COMM] Commission Pay: catch-up, w/c 12 Oct" },
]);

async function openPhone(page: Page, helper: string) {
  await page.goto(PHONE);
  await page.evaluate(decodeURIComponent(helper.slice("javascript:".length)));
  return page.locator("[data-litts-pay]");
}

test.describe("CEO", () => {
  test.use({ storageState: statePath("ceo") });

  test("the phone helper fills Pay Employee and ticks people off on Submit", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/commissions", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Copy phone helper" }).click();
    await expect(page.getByRole("button", { name: "Helper copied" })).toBeVisible();
    const helper = await page.evaluate(() => navigator.clipboard.readText());
    expect(helper).toMatch(/^javascript:/);

    await page.route(PHONE, (r) => r.fulfill({ contentType: "text/html", body: PHONE_HTML }));
    let panel = await openPhone(page, helper);
    await panel.getByLabel("Pay list").fill("not the list");
    await panel.getByRole("button", { name: "Load list" }).click();
    await expect(panel).toContainText("That isn't the list");
    await panel.getByLabel("Pay list").fill(LIST);
    await panel.getByRole("button", { name: "Load list" }).click();
    await expect(panel).toContainText("0 of 2 paid");

    // Only into Pay Employee: not with no form open, not into Transfer.
    await panel.getByRole("button", { name: "Fill next" }).click();
    await expect(panel).toContainText("Pay Employee, then click Fill again");
    await page.locator("#open-transfer").click();
    await panel.getByRole("button", { name: "Fill next" }).click();
    await expect(panel).toContainText("This is the Transfer form");
    await expect(page.locator("#sheet input").first()).toHaveValue("");
    await page.locator("#sheet").getByRole("button", { name: "Cancel" }).click();

    await page.locator("#open-pay").click();
    await panel.getByRole("button", { name: "Fill next" }).click();
    await expect(panel).toContainText("Filled for Avery Lane");
    await expect(page.locator("#sheet input")).toHaveCount(3);
    await expect(page.locator("#sheet [role=combobox]")).toHaveText("Select Employee");
    await page.locator("#sheet").getByRole("button", { name: "Submit" }).click();
    expect(await page.evaluate(() => (window as unknown as { submitted: string[][] }).submitted)).toEqual([
      ["40001", "1234", "[COMM] Commission Pay: w/c 26 Oct"],
    ]);
    await expect(panel).toContainText("1 of 2 paid");
    await expect(panel).toContainText("Ticked Avery Lane");

    // Changed after filling: not ticked.
    await page.locator("#open-pay").click();
    await panel.getByRole("button", { name: "Fill next" }).click();
    await expect(panel).toContainText("Filled for Jax Chaplan");
    await page.locator("#sheet input").nth(1).fill("9999");
    await page.locator("#sheet").getByRole("button", { name: "Submit" }).click();
    await expect(panel).toContainText("wasn't ticked");
    await expect(panel).toContainText("1 of 2 paid");

    // Ticks survive a reload of the phone page; the same list keeps them.
    panel = await openPhone(page, helper);
    await expect(panel).toContainText("1 of 2 paid");
    await panel.getByRole("button", { name: "Paste a new list" }).click();
    await panel.getByLabel("Pay list").fill(LIST);
    await panel.getByRole("button", { name: "Load list" }).click();
    await expect(panel).toContainText("1 already ticked");
    await panel.getByRole("button", { name: "Untick" }).click();
    await expect(panel).toContainText("0 of 2 paid");
  });
});
