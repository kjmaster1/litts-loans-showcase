import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import Link from "next/link";
import { TableHead } from "@/components/ui/table";
import { cn } from "@/lib/utils";

export type SortDir = "asc" | "desc";

/**
 * A sortable column header (redesign 2026-10): a link that sorts by this column
 * (first click: the column's natural direction; again: reverse). `aria-sort` tells
 * screen readers the current order.
 */
export function SortHeader({
  label,
  active,
  dir,
  href,
  align = "left",
  className,
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  /** Where clicking leads (the caller works out the next direction). */
  href: string;
  align?: "left" | "right";
  className?: string;
}) {
  const Icon = !active ? ArrowUpDown : dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <TableHead aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"} className={cn(align === "right" && "text-right", className)}>
      <Link
        href={href}
        scroll={false}
        className={cn(
          "-mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          align === "right" && "flex-row-reverse",
          active && "text-foreground",
        )}
      >
        {label}
        <Icon className={cn("size-3", !active && "opacity-50")} aria-hidden />
      </Link>
    </TableHead>
  );
}
