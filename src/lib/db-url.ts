/**
 * Neon's URLs say `sslmode=require`. node-postgres currently treats that as
 * `verify-full` but will switch to libpq's weaker meaning (no certificate
 * check) in pg v9, so pin full certificate verification explicitly.
 * URLs without an sslmode (local Docker) are left untouched.
 */
export function hardenConnectionString(url: string): string {
  const parsed = new URL(url);
  const mode = parsed.searchParams.get("sslmode");
  if (mode === "require" || mode === "prefer" || mode === "verify-ca") parsed.searchParams.set("sslmode", "verify-full");
  return parsed.toString();
}
