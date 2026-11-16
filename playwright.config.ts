import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests (tests/e2e; owner review 2026-10-11): crawl every page per role, hostile
 * URLs, accessibility (axe, WCAG + best practice, both themes) and the main flows.
 * Runs against a running production build: `pnpm build && pnpm start`, then `pnpm test:e2e`.
 * Nightly in CI on a fresh database seeded through the UI (.github/workflows/e2e.yml).
 */
export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.spec.ts",
  globalSetup: "./tests/e2e/global-setup.ts",
  // One shared database: run in order, one worker.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...devices["Desktop Chrome"],
    viewport: { width: 1366, height: 900 },
    // Local runs use the installed Chrome; CI installs Playwright's Chromium.
    channel: process.env.CI ? undefined : "chrome",
  },
});
