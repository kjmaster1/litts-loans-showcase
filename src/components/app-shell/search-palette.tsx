"use client";

import { FileText, HandCoins, House, Search, User, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { searchAction, type SearchHit } from "@/app/(app)/search-action";
import { Button } from "@/components/ui/button";
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import { OPEN_SEARCH, OPEN_SHORTCUTS } from "./keyboard-shortcuts";
import { Spinner } from "@/components/ui/spinner";
import { can } from "@/lib/permissions";
import { ADD_DATA, EXTRA_PAGES, NAV } from "./nav";
import { readRecent } from "./recently-viewed";
import { useShell } from "./shell-context";
import { startNavigationProgress } from "@/components/app-shell/navigation-progress";

const HIT_ICON = { borrower: User, loan: HandCoins, mortgage: House, staff: Users } as const;
const HIT_GROUP = { borrower: "Borrowers", loan: "Loans", mortgage: "Properties", staff: "Staff" } as const;

/**
 * Search palette (redesign 2026-10): Ctrl/⌘K from anywhere. Pages and "New"
 * actions match as you type; borrowers, loans, properties and staff come from the
 * server (only what the viewer may see).
 */
export function SearchPalette() {
  const router = useRouter();
  const { role, staffId } = useShell();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const show = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_SEARCH, show);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_SEARCH, show);
    };
  }, []);

  useEffect(() => {
    if (q.trim().length < 2) return;
    const t = setTimeout(() => {
      startTransition(async () => {
        const r = await searchAction(q);
        setHits(r.ok ? r.data : []);
      });
    }, 180);
    return () => clearTimeout(t);
  }, [q]);

  const term = q.trim().toLowerCase();
  const pages = useMemo(() => {
    const all = [...NAV.flatMap((g) => g.items), ...EXTRA_PAGES].filter((p) => !p.capability || can(role, p.capability));
    return (term ? all.filter((p) => p.title.toLowerCase().includes(term)) : all).slice(0, term ? 6 : 12);
  }, [term, role]);
  const actions = useMemo(
    () => ADD_DATA.filter((a) => can(role, a.capability) && (!term || `${a.title} ${a.description}`.toLowerCase().includes(term))),
    [term, role],
  );
  const shown = term.length >= 2 ? hits : [];
  // Only read while open: the dialog never renders on the server.
  const recent = open && !term ? readRecent(staffId) : [];

  const go = (href: string) => {
    setOpen(false);
    setQ("");
    setHits([]);
    startNavigationProgress();
    router.push(href);
  };

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        className="h-8 w-9 justify-center gap-2 px-0 text-muted-foreground sm:w-64 sm:justify-start sm:px-2.5"
        aria-label="Search (Ctrl+K)"
        aria-keyshortcuts="Control+K Meta+K"
      >
        <Search aria-hidden />
        <span className="hidden sm:inline">Search borrowers, loans…</span>
        <Kbd className="ml-auto hidden sm:inline-flex">Ctrl K</Kbd>
      </Button>
      <CommandDialog open={open} onOpenChange={setOpen} title="Search" description="Find a borrower, loan, property, page or action" className="sm:max-w-xl">
        <Command shouldFilter={false} loop>
          <CommandInput value={q} onValueChange={setQ} placeholder="Name, State ID, property, or a page…" />
          <CommandList className="max-h-[min(60vh,28rem)]">
            <CommandEmpty>{pending ? "Searching…" : term.length < 2 ? "Type at least two characters." : "Nothing found."}</CommandEmpty>
            {recent.length ? (
              <CommandGroup heading="Recently viewed">
                {recent.map((h) => {
                  const Icon = HIT_ICON[h.kind];
                  return (
                    <CommandItem key={h.href} value={`recent:${h.href}`} onSelect={() => go(h.href)}>
                      <Icon aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{h.title}</span>
                      <span className="truncate text-xs text-muted-foreground">{h.detail}</span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ) : null}
            {(["borrower", "loan", "mortgage", "staff"] as const).map((kind) => {
              const group = shown.filter((h) => h.kind === kind);
              if (!group.length) return null;
              const Icon = HIT_ICON[kind];
              return (
                <CommandGroup key={kind} heading={HIT_GROUP[kind]}>
                  {group.map((h) => (
                    <CommandItem key={h.href + h.title} value={h.href + h.title} onSelect={() => go(h.href)}>
                      <Icon aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{h.title}</span>
                      <span className="truncate text-xs text-muted-foreground">{h.detail}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              );
            })}
            {actions.length ? (
              <CommandGroup heading="New">
                {actions.map((a) => (
                  <CommandItem key={a.href} value={`action:${a.href}`} onSelect={() => go(a.href)}>
                    <a.icon aria-hidden />
                    <span className="flex-1">{a.title}</span>
                    <span className="text-xs text-muted-foreground">{a.description}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
            {pages.length ? (
              <CommandGroup heading="Go to">
                {pages.map((p) => (
                  <CommandItem key={p.href} value={`page:${p.href}`} onSelect={() => go(p.href)}>
                    {p.icon ? <p.icon aria-hidden /> : <FileText aria-hidden />}
                    <span className="flex-1">{p.title}</span>
                    <CommandShortcut>Page</CommandShortcut>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>
          {pending ? (
            <div className="flex items-center gap-2 border-t px-3 py-2 text-xs text-muted-foreground" role="status">
              <Spinner className="size-3" /> Searching…
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
              <span>
                <Kbd>↑</Kbd> <Kbd>↓</Kbd> to move · <Kbd>Enter</Kbd> to open
              </span>
              <button
                type="button"
                className="rounded underline-offset-4 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                onClick={() => {
                  setOpen(false);
                  window.dispatchEvent(new Event(OPEN_SHORTCUTS));
                }}
              >
                Keyboard shortcuts <Kbd>?</Kbd>
              </button>
            </div>
          )}
        </Command>
      </CommandDialog>
    </>
  );
}
