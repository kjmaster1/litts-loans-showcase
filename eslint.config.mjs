import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // One place formats text (owner review 2026-10-11: hand-rolled formatting drifted — a
    // missing "$", mixed locales, "Sept"). Use @/lib/format (or <Money>, <LocalTime>).
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/lib/format.ts", "src/lib/money.ts", "src/lib/dates.ts", "**/*.test.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.property.name='toLocaleString']",
          message: "Use formatCents / formatDollars / formatCount / formatBp from @/lib/format.",
        },
        {
          selector: "CallExpression[callee.property.name=/^toLocale(Date|Time)String$/]",
          message: "Use dateFormat() from @/lib/format (three-letter months, the app's date style) or <LocalTime>.",
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
