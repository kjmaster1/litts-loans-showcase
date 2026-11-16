import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";
import { totp } from "../support/totp";

export const PASSWORD = "quiet ledger green harbour 42";
export const AUTH_DIR = "tests/e2e/.auth";
export const ROLES = ["ceo", "management", "legal", "loan_officer"] as const;
export type E2eRole = (typeof ROLES)[number];
export const NAMES: Record<E2eRole, string> = { ceo: "E2E Chief", management: "E2E Manager", legal: "E2E Lawyer", loan_officer: "E2E Officer" };

export const statePath = (role: E2eRole) => `${AUTH_DIR}/${role}.json`;
export const accountsPath = `${AUTH_DIR}/accounts.json`;
export type Account = { username: string; secret: string; stateId: number };
export const accounts = (): Record<E2eRole, Account> => JSON.parse(readFileSync(accountsPath, "utf8"));
export const haveAccounts = () => existsSync(accountsPath);

/** A fresh invite link from the CLI (same database as the server under test). */
export function invite(stateId: number, name: string, role: E2eRole): string {
  const out = execSync(`pnpm --silent staff:invite --state-id ${stateId} --name "${name}" --role ${role}`, { encoding: "utf8" });
  const url = out.match(/https?:\/\/\S+\/invite\/\S+/)?.[0];
  if (!url) throw new Error(`No invite link in:\n${out}`);
  return url;
}

/** Accepts an invite and enrols 2FA; returns the TOTP secret. */
export async function signUp(page: Page, inviteUrl: string, username: string): Promise<string> {
  await page.goto(inviteUrl);
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL("**/enroll-2fa", { timeout: 30_000 });
  await page.getByLabel("Confirm your password").fill(PASSWORD);
  await page.getByRole("button", { name: "Continue" }).click();
  // Auth endpoints are rate-limited per address; back-to-back local runs can trip it.
  const limited = page.getByText(/Too many attempts/);
  if (await limited.waitFor({ timeout: 5_000 }).then(() => true, () => false)) {
    await page.waitForTimeout(61_000);
    await page.getByRole("button", { name: "Continue" }).click();
  }
  // Wait for the whole key (it renders after the password check), then enter the code. A
  // code typed as the 30-second window turns over can be refused, and 2FA checks are
  // limited to 5 a minute per address (repeated local runs hit it) — so wait and retry once.
  const key = page.locator("code.ident");
  await expect(key)
    .toHaveText(/^[A-Z2-7 ]{16,}$/, { timeout: 30_000 })
    .catch(async (e) => {
      throw new Error(`2FA key never appeared. Page says:\n${(await page.locator("main").innerText()).slice(0, 500)}\n${e}`);
    });
  const secret = ((await key.textContent()) ?? "").replace(/\s+/g, "");
  const stored = page.getByLabel("I’ve stored these codes somewhere safe");
  for (const attempt of [0, 1]) {
    if (attempt) await page.waitForTimeout(61_000);
    await page.locator('input[autocomplete="one-time-code"]').fill(totp(secret));
    if (await stored.waitFor({ timeout: 10_000 }).then(() => true, () => false)) break;
    if (attempt) throw new Error("2FA enrolment code was refused twice");
  }
  await stored.check();
  await page.getByRole("button", { name: "Go to dashboard" }).click();
  await page.waitForURL((u) => u.pathname === "/" || u.pathname === "/my-work", { timeout: 30_000 });
  // A first visit opens the app tour's welcome; other specs start without it (tour.spec.ts resets it).
  await page.getByRole("button", { name: "Not now" }).click();
  await expect(page.getByText("You can take the tour any time from your account menu.")).toBeVisible();
  await page.waitForLoadState("networkidle");
  return secret;
}

/** Collects console errors and page errors while a test runs. */
export function watchErrors(page: Page, ignore: RegExp[] = [/status of 404/]) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror @ ${page.url()}: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !ignore.some((r) => r.test(m.text()))) errors.push(`console @ ${page.url()}: ${m.text()}`);
  });
  return {
    errors,
    expectNone: () => expect(errors, errors.join("\n")).toEqual([]),
  };
}
