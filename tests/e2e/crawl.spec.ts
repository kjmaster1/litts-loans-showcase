import { expect, test, type Page } from "@playwright/test";
import { ROLES, statePath } from "./support";

/**
 * Every page each role can reach, by following links from the home page: no server errors,
 * no console or page errors, no hydration warnings, no failed requests, no "NaN" or
 * "undefined" on screen — and every Excel download is a spreadsheet.
 */
const SUSPICIOUS = /Application error|Something went wrong|Unhandled Runtime Error|\bNaN\b|\bundefined\b|\[object Object\]|Invalid Date/;
const pattern = (u: URL) =>
  u.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ":id").replace(/\/\d{3,}(?=\/|$)/g, "/:n") + (u.search ? `?${[...u.searchParams.keys()].sort().join("&")}` : "");

for (const role of ROLES) {
  test(`crawl as ${role}`, async ({ browser, baseURL }) => {
    test.setTimeout(15 * 60_000);
    const ctx = await browser.newContext({ storageState: statePath(role) });
    const page: Page = await ctx.newPage();
    const problems: string[] = [];
    let current = "";
    page.on("pageerror", (e) => problems.push(`pageerror @ ${current}: ${e.message}`));
    page.on("console", (m) => {
      if ((m.type() === "error" && !/status of 404/.test(m.text())) || (m.type() === "warning" && /hydrat|did not match/i.test(m.text()))) {
        problems.push(`console.${m.type()} @ ${current}: ${m.text().slice(0, 200)}`);
      }
    });
    page.on("response", (r) => {
      const u = new URL(r.url());
      if (u.origin === baseURL && r.status() >= 400 && r.request().resourceType() !== "document") problems.push(`http ${r.status()} @ ${current}: ${u.pathname}`);
    });

    const queue = ["/"];
    const seen = new Set<string>();
    const perPattern = new Map<string, number>();
    const downloads = new Set<string>();
    let visited = 0;
    while (queue.length && visited < 160) {
      const url = new URL(queue.shift()!, baseURL);
      const key = url.pathname + url.search;
      const pat = pattern(url);
      if (seen.has(key) || (perPattern.get(pat) ?? 0) >= 2) continue;
      seen.add(key);
      perPattern.set(pat, (perPattern.get(pat) ?? 0) + 1);
      current = key;
      const res = await page.goto(url.href, { waitUntil: "networkidle" });
      visited++;
      const status = res?.status() ?? 0;
      if (status >= 400 && new URL(page.url()).pathname !== "/forbidden") problems.push(`page ${status} @ ${key}`);
      const text = await page.locator("body").innerText();
      const odd = text.match(new RegExp(`.{0,50}(${SUSPICIOUS.source}).{0,50}`));
      if (odd) problems.push(`text @ ${key}: ${odd[0].replace(/\s+/g, " ")}`);
      for (const href of await page.$$eval("a[href]", (as) => as.map((a) => a.getAttribute("href") ?? ""))) {
        if (!href || href.startsWith("#") || href.startsWith("mailto:")) continue;
        const u = new URL(href, page.url());
        if (u.origin !== baseURL || u.pathname.startsWith("/api/") || u.pathname.startsWith("/_next/")) continue;
        if (/\/export(\?|$)/.test(u.pathname)) downloads.add(u.pathname + u.search);
        else if (!seen.has(u.pathname + u.search)) queue.push(u.pathname + u.search);
      }
    }
    for (const d of downloads) {
      const r = await ctx.request.get(d);
      const type = r.headers()["content-type"] ?? "";
      if (r.status() !== 200 || !type.includes("spreadsheet")) problems.push(`download ${d}: ${r.status()} ${type}`);
    }
    await ctx.close();
    test.info().annotations.push({ type: "crawl", description: `${visited} pages, ${downloads.size} downloads` });
    expect(visited, "the crawl should reach the app, not the sign-in page").toBeGreaterThan(5);
    expect(problems, problems.join("\n")).toEqual([]);
  });
}
