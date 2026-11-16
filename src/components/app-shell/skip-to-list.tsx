"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useSyncExternalStore } from "react";

/**
 * A second skip link, straight after "Skip to content", on pages with a main list
 * (an element with id="results"): past the sidebar, figures, tabs and filters to the
 * rows (QA 2026-10-10).
 */
export function SkipToList() {
  // Re-check whenever the page changes.
  const key = `${usePathname()}?${useSearchParams()}`;
  const hasList = useSyncExternalStore(
    (onChange) => {
      const obs = new MutationObserver(onChange);
      obs.observe(document.body, { childList: true, subtree: true });
      return () => obs.disconnect();
    },
    () => !!document.getElementById("results"),
    () => false,
  );
  if (!hasList) return null;
  return (
    <a
      key={key}
      href="#results"
      className="sr-only rounded-md bg-background px-3 py-2 focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:ring-3 focus:ring-ring"
    >
      Skip to the list
    </a>
  );
}
