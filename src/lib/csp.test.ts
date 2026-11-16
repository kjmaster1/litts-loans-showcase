import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { buildCsp, EMPTY_STYLE_HASH, SONNER_STYLE_HASH } from "./csp";

const sha256 = (s: string) => `sha256-${createHash("sha256").update(s).digest("base64")}`;

describe("buildCsp", () => {
  const prod = buildCsp({ nonce: "abc", isDev: false, isHttps: true });

  it("is strict in production", () => {
    expect(prod).toContain("script-src 'self' 'nonce-abc' 'strict-dynamic'");
    expect(prod).not.toMatch(/script-src[^;]*unsafe-(inline|eval)/);
    expect(prod).not.toMatch(/style-src [^;]*unsafe-inline/);
    expect(prod).toContain("frame-ancestors 'none'");
    expect(prod).toContain("object-src 'none'");
    expect(prod).toContain("upgrade-insecure-requests");
  });

  it("omits upgrade-insecure-requests over plain HTTP", () => {
    expect(buildCsp({ nonce: "abc", isDev: false, isHttps: false })).not.toContain("upgrade-insecure-requests");
  });

  it("pins the exact stylesheet Sonner injects (fails if Sonner is upgraded)", () => {
    const require = createRequire(import.meta.url);
    const src = readFileSync(require.resolve("sonner").replace(/index\.js$/, "index.mjs"), "utf8");
    const start = src.indexOf('__insertCSS("') + "__insertCSS(".length;
    const css = JSON.parse(src.slice(start, src.indexOf('");', start) + 1)) as string;
    expect(sha256(css)).toBe(SONNER_STYLE_HASH);
  });

  it("uses the hash of the empty string", () => {
    expect(sha256("")).toBe(EMPTY_STYLE_HASH);
  });
});
