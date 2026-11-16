import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";
import { buildCsp } from "@/lib/csp";

/**
 * Runs before every page request:
 * 1. Issues a per-request nonce and strict Content-Security-Policy (ADR 0003).
 * 2. Optimistically redirects visitors without a session cookie to sign-in.
 *    This is a UX shortcut only — the real check is `requireViewer()` /
 *    `authorize()` in the data access layer, on every page and action.
 */

const PUBLIC_PATHS = ["/sign-in", "/two-factor", "/invite/", "/reset-password/"];

function isPublic(pathname: string) {
  return PUBLIC_PATHS.some((p) => (p.endsWith("/") ? pathname.startsWith(p) : pathname === p));
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (!isPublic(pathname) && !getSessionCookie(request, { cookiePrefix: "litts" })) {
    const url = new URL("/sign-in", request.url);
    if (pathname !== "/") url.searchParams.set("next", pathname + search);
    return NextResponse.redirect(url);
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const isHttps = request.nextUrl.protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
  const csp = buildCsp({ nonce, isDev: process.env.NODE_ENV === "development", isHttps });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico|brand/|robots.txt).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
