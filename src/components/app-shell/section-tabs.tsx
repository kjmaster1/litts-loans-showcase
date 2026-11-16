"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { can } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { FINANCE_TABS } from "./nav";
import { useShell } from "./shell-context";

type Tab = { title: string; href: string };

/** A section's own pages as a tab bar under the page title (redesign 2026-10). */
export function SectionTabs({ label, tabs }: { label: string; tabs: Tab[] }) {
  const pathname = usePathname();
  // The most specific tab whose path the URL starts with.
  const current = tabs
    .map((t) => t.href)
    .filter((h) => pathname === h || pathname.startsWith(`${h}/`))
    .sort((a, b) => b.length - a.length)[0];
  // The page header draws the line beneath this bar, full width.
  return (
    <nav aria-label={label} className="tab-bar shadow-none">
      {tabs.map((t) => {
        const active = t.href === current;
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "inline-flex h-9 shrink-0 items-center border-b-2 px-2.5 text-sm whitespace-nowrap transition-colors focus-visible:rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
              active ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
            )}
          >
            {t.title}
          </Link>
        );
      })}
    </nav>
  );
}

export function FinanceTabs() {
  const { role } = useShell();
  return <SectionTabs label="Finance" tabs={FINANCE_TABS.filter((t) => !t.capability || can(role, t.capability))} />;
}
