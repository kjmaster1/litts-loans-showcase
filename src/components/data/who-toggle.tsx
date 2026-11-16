import Link from "next/link";
import { cn } from "@/lib/utils";

/** "Everyone / Mine" switch for team lists (owner, 2026-10-11). */
export function WhoToggle({ all, mine, isMine, label }: { all: string; mine: string; isMine: boolean; label: string }) {
  const item = (href: string, active: boolean, text: string) => (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "rounded-md px-2.5 py-1 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        active ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {text}
    </Link>
  );
  return (
    <nav aria-label={`Whose ${label}`} className="inline-flex gap-0.5 rounded-lg bg-muted p-0.5">
      {item(all, !isMine, "Everyone")}
      {item(mine, isMine, "Mine")}
    </nav>
  );
}
