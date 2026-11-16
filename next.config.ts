import type { NextConfig } from "next";

/**
 * Rendering: every page is dynamic. `cacheComponents` / Partial Prerendering
 * are deliberately OFF because they are incompatible with a nonce-based strict
 * CSP and with per-request session checks (ADR 0003).
 *
 * The Content-Security-Policy itself is set per request (with a nonce) in
 * `src/proxy.ts`; the static headers below apply to every response.
 */
const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=(), publickey-credentials-get=(self), publickey-credentials-create=(self)" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  experimental: {
    // Bank exports are uploaded via a Server Action. Vercel caps request bodies
    // at 4.5 MB; the app itself rejects files over 3.5 MB (src/server/bank/import.ts).
    serverActions: { bodySizeLimit: "4mb" },
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // Authenticated pages and auth API responses must never be cached by shared caches.
      { source: "/((?!_next/static|_next/image|brand).*)", headers: [{ key: "Cache-Control", value: "no-store" }] },
    ];
  },
};

export default nextConfig;
