import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = fileURLToPath(new URL("./src", import.meta.url));
const empty = fileURLToPath(new URL("./tests/support/empty-module.ts", import.meta.url));

/** Test-only environment. Integration tests use a separate database. */
const testEnv = {
  NODE_ENV: "test" as const,
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://litts:litts_dev_password@localhost:54329/litts_loans_test",
  BETTER_AUTH_URL: "http://localhost:3000",
  BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0000",
  AUDIT_HMAC_KEY: "test-audit-key-test-audit-key-test-0000",
};

const shared = {
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${src}/` },
      // `server-only` throws outside the React Server Components bundler.
      { find: /^server-only$/, replacement: empty },
    ],
  },
};

export default defineConfig({
  test: {
    projects: [
      {
        ...shared,
        // Isolated too: the unit files run in parallel in ~1 s either way, and one of them mocks `@/server/db`.
        test: { name: "unit", include: ["src/**/*.test.ts"], environment: "node", env: testEnv, isolate: true },
      },
      {
        ...shared,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          env: testEnv,
          globalSetup: ["tests/support/global-setup.ts"],
          // One shared database: run files serially to keep them independent.
          fileParallelism: false,
          // A fresh worker per file on purpose: files mock modules (`vi.mock`) and hold module state that mustn't
          // carry into the next file. Vitest's "isolate: false" hint would save ~4 s a run.
          isolate: true,
          testTimeout: 20_000,
          // `beforeAll` imports the whole bank export (and often pastes every tab): ~3 s, once 10 s on a stalled CI
          // runner (Dependabot PR #3, 2026-10-13).
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
