/**
 * Content-Security-Policy builder (ADR 0003). Pure so it can be unit-tested.
 *
 * Inline <style> elements are allowed only by nonce or by exact hash:
 * - Sonner injects a fixed stylesheet at import time and has no nonce option,
 *   so its exact SHA-256 is allow-listed. `csp.test.ts` recomputes it from the
 *   installed package, so upgrading Sonner fails the test instead of silently
 *   unstyling toasts.
 * - The empty-string hash covers libraries that append an empty <style> and
 *   fill it via CSSOM (harmless: an empty stylesheet does nothing).
 */
export const SONNER_STYLE_HASH = "sha256-StEaX+se6YS7pqjzrzMIA0KaX9zF/8zAhvQXZAe5epY=";
export const EMPTY_STYLE_HASH = "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=";

export function buildCsp(opts: { nonce: string; isDev: boolean; isHttps: boolean }): string {
  const { nonce, isDev, isHttps } = opts;
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    isDev
      ? "style-src 'self' 'unsafe-inline'"
      : `style-src 'self' 'nonce-${nonce}' '${SONNER_STYLE_HASH}' '${EMPTY_STYLE_HASH}'`,
    // Style *attributes* (Base UI positioning, CSS variables) can't carry a nonce.
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "manifest-src 'self'",
    "worker-src 'self' blob:",
    // Only meaningful (and only safe) when the page itself is served over HTTPS.
    ...(isHttps ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}
