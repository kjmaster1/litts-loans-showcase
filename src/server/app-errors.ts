import { Client } from "pg";
import { hardenConnectionString } from "@/lib/db-url";

/**
 * Records a server error for the daily health check (no `server-only`: this also runs from
 * `instrumentation.ts`, outside React Server Components). Errors are rare, so a short-lived
 * connection is fine; recording must never throw or slow the failing request much.
 */
export async function recordAppError(e: { source: string; route?: string | null; method?: string | null; error: unknown }): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url || process.env.NODE_ENV === "test") return;
  const message = (e.error instanceof Error ? `${e.error.name}: ${e.error.message}` : String(e.error)).slice(0, 500);
  const digest = typeof e.error === "object" && e.error !== null && "digest" in e.error ? String((e.error as { digest: unknown }).digest) : null;
  // Next's own control flow (redirect, notFound) is not an error.
  if (digest?.startsWith("NEXT_") || /NEXT_(REDIRECT|NOT_FOUND|HTTP_ERROR_FALLBACK)/.test(message)) return;
  const client = new Client({ connectionString: hardenConnectionString(url), connectionTimeoutMillis: 3_000, statement_timeout: 3_000 });
  try {
    await client.connect();
    await client.query("insert into app_error (source, route, method, message, digest) values ($1, $2, $3, $4, $5)", [
      e.source.slice(0, 40),
      e.route?.slice(0, 200) ?? null,
      e.method?.slice(0, 10) ?? null,
      message,
      digest?.slice(0, 100) ?? null,
    ]);
  } catch (err) {
    console.error("[app-error] could not record", err);
  } finally {
    await client.end().catch(() => {});
  }
}
