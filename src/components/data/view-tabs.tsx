import Link from "next/link";
import { cn } from "@/lib/utils";

export type ViewTab = {
  key: string;
  label: string;
  href: string;
  /** Shown as a pill after the label; `null`/absent shows none. */
  count?: number | null;
  /** "attention": a non-zero count is work waiting (e.g. rows to review). */
  tone?: "attention";
};

/**
 * Filters a list by status or view, as links (UX review 2026-10-12: Loans, Mortgages,
 * Transactions and Reports each had their own copy — three without a focus ring).
 */
export function ViewTabs({ label, tabs, current }: { label: string; tabs: ViewTab[]; current: string }) {
  return (
    <nav aria-label={label} className="tab-bar">
      {tabs.map((tab) => {
        const active = tab.key === current;
        const count = tab.count ?? null;
        return (
          <Link
            key={tab.key}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors focus-visible:rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
              active ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
            )}
          >
            {tab.label}
            {count !== null ? (
              <span
                className={cn(
                  "num rounded-full px-1.5 text-xs",
                  tab.tone === "attention" && count > 0 ? "bg-danger-subtle text-danger" : active ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
                )}
              >
                {count}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
