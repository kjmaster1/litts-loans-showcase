import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chromium, type FullConfig } from "@playwright/test";
import { accountsPath, AUTH_DIR, invite, NAMES, ROLES, signUp, statePath, type Account, type E2eRole } from "./support";

/**
 * One account per role, signed up through the real invite + 2FA flow, sessions saved for
 * the specs. With E2E_SEED=1 (CI's empty database) the CEO then loads the anonymised
 * fixtures through the UI: bank export, the four phone-card tabs, a tablet agreement and an
 * allowance reading — which also tests those flows end to end.
 */
export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0].use.baseURL!;
  const channel = config.projects[0].use.channel;
  mkdirSync(AUTH_DIR, { recursive: true });
  const browser = await chromium.launch({ channel });
  const run = Date.now() % 100_000;
  const created = {} as Record<E2eRole, Account>;

  for (const [i, role] of ROLES.entries()) {
    const stateId = 8_000_000 + run * 10 + i; // unique per run, so local runs never collide
    const username = `e2e.${role.replace("_", "")}.${run}`;
    const ctx = await browser.newContext({ baseURL });
    const page = await ctx.newPage();
    const secret = await signUp(page, invite(stateId, NAMES[role], role), username);
    await ctx.storageState({ path: statePath(role) });
    created[role] = { username, secret, stateId };
    await ctx.close();
  }
  writeFileSync(accountsPath, JSON.stringify(created, null, 2));

  if (process.env.E2E_SEED === "1") {
    const ctx = await browser.newContext({ baseURL, storageState: statePath("ceo") });
    const page = await ctx.newPage();
    page.setDefaultTimeout(60_000);

    await page.goto("/finance/imports");
    await page.locator('input[type="file"]').setInputFiles("tests/fixtures/bank-export.xlsx");
    await page.getByRole("button", { name: "Check file" }).click();
    await page.getByRole("button", { name: "Confirm import" }).click();
    await page.waitForURL(/\/finance\/imports\/[0-9a-f-]{36}$/);

    await page.goto("/loans/import");
    for (const [file, label] of [["active", "Active"], ["overdue", "Overdue"], ["default", "Default"], ["complete", "Complete"]] as const) {
      await page.getByRole("radio", { name: label }).click();
      await page.getByLabel("Tab contents").fill(readFileSync(`tests/fixtures/paste-${file}.txt`, "utf8"));
      await page.getByRole("button", { name: "Preview" }).click();
      await page.getByRole("button", { name: `Save ${label} tab` }).waitFor();
      if (file === "active") {
        // Give the e2e officer their own loans, so their pages have something on them.
        await page.getByLabel("Officer for all unassigned loans").click();
        await page.getByRole("option", { name: NAMES.loan_officer }).click();
      }
      await page.getByRole("button", { name: `Save ${label} tab` }).click();
      await page.getByText(`${label} tab saved`).waitFor();
    }

    await page.goto("/mortgages/import");
    await page.getByLabel("Agreement text").fill(readFileSync("tests/fixtures/paste-mortgage.txt", "utf8"));
    await page.getByRole("button", { name: "Preview" }).click();
    await page.getByRole("button", { name: /Save 1 agreement/ }).click();
    await page.getByText(/Saved 1 agreement/).waitFor();

    await page.goto("/finance/allowance");
    await page.getByLabel("State Allowance Balance").fill("1000000");
    await page.getByRole("button", { name: "Record reading" }).click();
    await page.getByText(/recorded/i).first().waitFor();
    await ctx.close();
  }
  await browser.close();
}
