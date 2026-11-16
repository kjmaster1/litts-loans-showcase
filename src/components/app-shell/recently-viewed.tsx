"use client";

import { useEffect } from "react";
import { useShell } from "./shell-context";

/**
 * Recently viewed borrowers, loans and properties for the search palette
 * (research/12). Kept in this browser only, per staff member; storage can be
 * missing or blocked, so every access is guarded and the app works without it.
 */

export type RecentItem = { kind: "borrower" | "loan" | "mortgage"; title: string; detail: string; href: string };

const MAX = 8;
const keyFor = (staffId: string) => `litts.recent.${staffId}`;

export function readRecent(staffId: string): RecentItem[] {
  try {
    const raw = window.localStorage.getItem(keyFor(staffId));
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((i): i is RecentItem => typeof i?.href === "string" && typeof i?.title === "string" && i.href.startsWith("/")).slice(0, MAX) : [];
  } catch {
    return [];
  }
}

function remember(staffId: string, item: RecentItem) {
  try {
    const list = [item, ...readRecent(staffId).filter((i) => i.href !== item.href)].slice(0, MAX);
    window.localStorage.setItem(keyFor(staffId), JSON.stringify(list));
  } catch {
    // Private window or storage blocked: nothing to remember.
  }
}

/** Drop on a detail page to add it to the viewer's recent items. Renders nothing. */
export function RecentlyViewed({ item }: { item: RecentItem }) {
  const { staffId } = useShell();
  const { kind, title, detail, href } = item;
  useEffect(() => {
    remember(staffId, { kind, title, detail, href });
  }, [staffId, kind, title, detail, href]);
  return null;
}
