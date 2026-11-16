import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * The primary link of a table row, stretched over the whole row (redesign 2026-10):
 * the row is one big target (Fitts) but still a single tab stop with a real link name.
 * The row needs `className="relative"`; other interactive cells need `relative z-10`.
 */
export function RowLink({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) {
  return (
    <Link
      href={href}
      className={cn(
        "font-medium underline-offset-4 outline-none after:absolute after:inset-0 after:content-[''] hover:underline focus-visible:underline focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset",
        className,
      )}
    >
      {children}
    </Link>
  );
}

/** Row classes for a table whose rows carry a RowLink. */
export const linkedRow = "relative cursor-pointer";
