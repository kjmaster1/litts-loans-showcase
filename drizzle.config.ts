import { defineConfig } from "drizzle-kit";

// drizzle-kit runs outside Next.js, so load env files the same way Next does.
for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // file absent — fine (e.g. CI injects env directly)
  }
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema/index.ts",
  out: "./drizzle",
  casing: "snake_case",
  dbCredentials: { url: process.env.DATABASE_URL! },
  strict: true,
  verbose: true,
});
