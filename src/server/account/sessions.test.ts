import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/db", () => ({ db: {} }));
vi.mock("@/server/request", () => ({ getRequestMeta: async () => ({ ip: null, userAgent: null }) }));

const { describeUserAgent } = await import("./sessions");

describe("describeUserAgent", () => {
  it.each([
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36", "Chrome on Windows"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0 Safari/537.36 Edg/141.0", "Edge on Windows"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15", "Safari on macOS"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1", "Safari on iOS"],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0", "Firefox on Linux"],
  ])("%s", (ua, expected) => {
    expect(describeUserAgent(ua)).toBe(expected);
  });

  it("handles a missing user agent", () => {
    expect(describeUserAgent(null)).toBe("Unknown device");
  });
});
