"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { startNavigationProgress } from "@/components/app-shell/navigation-progress";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { can, type Capability } from "@/lib/permissions";
import { useShell } from "./shell-context";

/**
 * Keyboard shortcuts (owner, 2026-10-11), Linear/GitHub style: "?" lists them, "/" searches
 * the page's list, "g" then a letter goes somewhere, "n" then a letter starts something.
 * Never while typing in a field, never with Ctrl/⌘/Alt (so browser and screen-reader keys
 * are untouched), and they can be switched off — WCAG 2.1.4 Character Key Shortcuts.
 */

const STORE = "litts.shortcuts";
export const OPEN_SHORTCUTS = "litts:shortcuts";
export const OPEN_SEARCH = "litts:search";

type Target = { keys: string; title: string; href: string; capability?: Capability };
const GO: Target[] = [
  { keys: "g d", title: "Dashboard", href: "/", capability: "dashboard.company" },
  { keys: "g w", title: "My work", href: "/my-work", capability: "loans.originate" },
  { keys: "g c", title: "Collections", href: "/loans/collections" },
  { keys: "g l", title: "Loans", href: "/loans" },
  { keys: "g m", title: "Mortgages", href: "/mortgages" },
  { keys: "g b", title: "Borrowers", href: "/loans/borrowers", capability: "borrower.lookup" },
  { keys: "g f", title: "Finance", href: "/finance", capability: "finance.view" },
  { keys: "g o", title: "Commissions", href: "/commissions" },
];
const NEW: Target[] = [
  { keys: "n l", title: "New loan", href: "/loans/new", capability: "loans.originate" },
  { keys: "n q", title: "New mortgage quote", href: "/mortgages/quotes/new", capability: "loans.originate" },
  { keys: "n p", title: "Paste phone cards", href: "/loans/import", capability: "imports.paste" },
  { keys: "n t", title: "Paste from tablet", href: "/mortgages/import", capability: "imports.paste" },
];

const typing = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.closest("[role=dialog]:not([data-closed]):not([data-ending-style]),[role=menu],[role=listbox]") !== null);

function readEnabled(): boolean {
  try {
    return localStorage.getItem(STORE) !== "off";
  } catch {
    return true;
  }
}

export function KeyboardShortcuts() {
  const router = useRouter();
  const { role } = useShell();
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const pending = useRef<{ prefix: string; at: number } | null>(null);
  const allowed = (t: Target) => !t.capability || can(role, t.capability);
  const go = GO.filter(allowed);
  const create = NEW.filter(allowed);

  useEffect(() => {
    // Read the saved choice after hydration (localStorage isn't there on the server).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEnabled(readEnabled());
    const show = () => setOpen(true);
    window.addEventListener(OPEN_SHORTCUTS, show);
    return () => window.removeEventListener(OPEN_SHORTCUTS, show);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const targets = [...GO, ...NEW].filter((t) => !t.capability || can(role, t.capability));
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
      const key = e.key.toLowerCase();
      if (e.key === "?") {
        e.preventDefault();
        setOpen(true);
        return;
      }
      if (key === "/") {
        e.preventDefault();
        const field = document.querySelector<HTMLInputElement>("[data-list-search]") ?? document.querySelector<HTMLInputElement>("main [role=search] input");
        if (field) field.focus();
        else window.dispatchEvent(new Event(OPEN_SEARCH));
        return;
      }
      const p = pending.current;
      if (p && Date.now() - p.at < 1500) {
        pending.current = null;
        const hit = targets.find((t) => t.keys === `${p.prefix} ${key}`);
        if (hit) {
          e.preventDefault();
          startNavigationProgress();
          router.push(hit.href);
        }
        return;
      }
      if (key === "g" || key === "n") pending.current = { prefix: key, at: Date.now() };
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, role, router]);

  const toggle = () => {
    const next = !enabled;
    setEnabled(next);
    try {
      localStorage.setItem(STORE, next ? "on" : "off");
    } catch {
      // Private window: the choice lasts for this page only.
    }
  };

  const row = (keys: string, title: string) => (
    <li key={keys} className="flex items-center justify-between gap-4 py-1.5 text-sm">
      <span>{title}</span>
      <span className="flex items-center gap-1 text-muted-foreground">
        {keys.split(" ").map((k, i) => (
          <span key={i} className="flex items-center gap-1">
            {i > 0 ? <span className="text-xs">then</span> : null}
            <Kbd>{k.toUpperCase()}</Kbd>
          </span>
        ))}
      </span>
    </li>
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Keys that open pages and start work. They don&rsquo;t fire while you&rsquo;re typing in a field.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
          <section>
            <h3 className="mb-1 text-xs font-medium text-muted-foreground">General</h3>
            <ul className="divide-y">
              <li className="flex items-center justify-between gap-4 py-1.5 text-sm">
                <span>Search everything</span>
                <Kbd>Ctrl K</Kbd>
              </li>
              {row("/", "Search this list")}
              {row("?", "Show shortcuts")}
              <li className="flex items-center justify-between gap-4 py-1.5 text-sm">
                <span>Close a window</span>
                <Kbd>Esc</Kbd>
              </li>
            </ul>
            {create.length ? (
              <>
                <h3 className="mt-4 mb-1 text-xs font-medium text-muted-foreground">Start</h3>
                <ul className="divide-y">{create.map((t) => row(t.keys, t.title))}</ul>
              </>
            ) : null}
          </section>
          <section>
            <h3 className="mb-1 text-xs font-medium text-muted-foreground">Go to</h3>
            <ul className="divide-y">{go.map((t) => row(t.keys, t.title))}</ul>
          </section>
        </div>
        <label className="mt-2 flex items-start gap-2 rounded-lg border p-3 text-sm">
          <input type="checkbox" className="mt-0.5 size-4 accent-primary" checked={enabled} onChange={toggle} />
          <span>
            <span className="font-medium">Single-key shortcuts</span>
            <span className="block text-xs text-muted-foreground">
              Turn off if they get in the way (e.g. with speech input). Ctrl K and this list ({enabled ? "?" : "the user menu"}) keep working. Saved on this browser.
            </span>
          </span>
        </label>
      </DialogContent>
    </Dialog>
  );
}
