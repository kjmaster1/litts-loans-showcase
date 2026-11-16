"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * A thin bar across the top while a page loads (QA 2026-10-10). It replaces the
 * route-level loading screens: those start streaming before a page can say
 * "not found" or "no access", so those pages came back as HTTP 200. Without them
 * pages answer with their real status, and this bar still shows a click landed.
 */

const EVENT = "litts:navigate";

/** For code that navigates with `router.push` rather than a link. */
export function startNavigationProgress() {
  window.dispatchEvent(new Event(EVENT));
}

export function NavigationProgress() {
  const pathname = usePathname();
  const search = useSearchParams();
  const here = `${pathname}?${search}`;
  // Where a navigation started from; once the location differs, it has arrived.
  const [from, setFrom] = useState<string | null>(null);
  const safety = useRef<ReturnType<typeof setTimeout> | null>(null);
  const state = from === null ? "idle" : from === here ? "loading" : "done";

  useEffect(() => {
    const start = () => {
      setFrom(`${location.pathname}?${location.search.replace(/^\?/, "")}`);
      if (safety.current) clearTimeout(safety.current);
      // Never spin forever (e.g. a link that turns out to be a download).
      safety.current = setTimeout(() => setFrom(null), 15_000);
    };
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a");
      if (!a || !a.href || a.target === "_blank" || a.hasAttribute("download")) return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin || url.pathname.endsWith("/export") || url.pathname.startsWith("/api/")) return;
      if (url.pathname === location.pathname && url.search === location.search) return;
      start();
    };
    document.addEventListener("click", onClick, true);
    window.addEventListener(EVENT, start);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener(EVENT, start);
    };
  }, []);

  // Arrived: let the bar finish, then hide it.
  useEffect(() => {
    if (state !== "done") return;
    if (safety.current) clearTimeout(safety.current);
    const t = setTimeout(() => setFrom(null), 300);
    return () => clearTimeout(t);
  }, [state]);

  return (
    <>
      <div aria-hidden className="pointer-events-none fixed inset-x-0 top-0 z-[60] h-0.5">
        <div
          className={cn(
            "h-full bg-primary transition-[width,opacity] ease-out motion-reduce:transition-none",
            state === "idle" && "w-0 opacity-0 duration-0",
            state === "loading" && "w-4/5 opacity-100 duration-[8000ms]",
            state === "done" && "w-full opacity-0 duration-300",
          )}
        />
      </div>
      <div role="status" className="sr-only">
        {state === "loading" ? "Loading page…" : ""}
      </div>
    </>
  );
}
