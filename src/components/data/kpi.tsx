import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * Headline figures (redesign 2026-10): one surface, figures divided by hairlines,
 * instead of a grid of separate cards. 2 columns on phones, `cols` from `lg`.
 */
export function StatStrip({ children, cols = 4, className }: { children: React.ReactNode; cols?: 2 | 3 | 4 | 5 | 6; className?: string }) {
  const lg = { 2: "lg:grid-cols-2", 3: "lg:grid-cols-3", 4: "lg:grid-cols-4", 5: "lg:grid-cols-5", 6: "lg:grid-cols-6" }[cols];
  return (
    <section
      aria-label="Key figures"
      className={cn(
        "grid grid-cols-2 gap-px overflow-hidden rounded-lg bg-border shadow-xs ring-1 ring-foreground/[0.08] dark:shadow-none dark:ring-foreground/10",
        // An odd figure out on two columns takes the full width rather than leaving a gap.
        "[&>*:last-child:nth-child(odd)]:col-span-2 lg:[&>*:last-child:nth-child(odd)]:col-span-1",
        lg,
        className,
      )}
    >
      {children}
    </section>
  );
}

const TONE_DOT = { warn: "bg-warning", bad: "bg-danger" } as const;

/** One figure in a StatStrip: label, value, a short note. `href` makes the whole cell a link. */
export function Kpi({ label, children, hint, tone, href }: { label: React.ReactNode; children: React.ReactNode; hint?: React.ReactNode; tone?: "warn" | "bad"; href?: string }) {
  const body = (
    <>
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {tone ? <span className={cn("size-1.5 rounded-full", TONE_DOT[tone])} aria-hidden /> : null}
        {label}
      </div>
      <div className="num mt-1 text-xl leading-7 font-semibold tracking-tight">{children}</div>
      {hint ? <div className="mt-0.5 text-xs leading-4 text-muted-foreground">{hint}</div> : null}
    </>
  );
  const cell = "min-w-0 bg-card px-4 py-3";
  return href ? (
    <Link href={href} className={cn(cell, "transition-colors hover:bg-muted/50 focus-visible:relative focus-visible:z-10 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none")}>
      {body}
    </Link>
  ) : (
    <div className={cell}>{body}</div>
  );
}
