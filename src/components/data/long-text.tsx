import { cn } from "@/lib/utils";

/**
 * The first `limit` characters and "…", or the text itself when it's short enough. Counts whole
 * characters, so an emoji is never cut in half (slicing UTF-16 units would leave a broken one).
 */
export function shorten(text: string, limit: number): string {
  const chars = Array.from(text);
  return chars.length <= limit ? text : `${chars.slice(0, limit).join("").trimEnd()}…`;
}

/**
 * Free text (notes, collection logs) that can run to pages: past `limit` characters it shows
 * the start and a "Show the whole note" toggle (UX review 2026-10-12 — one long note pushed a
 * borrower's history off the screen). A native <details>, so it works without JavaScript.
 */
export function LongText({ text, className, limit = 400 }: { text: string; className?: string; limit?: number }) {
  const base = cn("whitespace-pre-wrap [overflow-wrap:anywhere]", className);
  const start = shorten(text, limit);
  if (start === text) return <p className={base}>{text}</p>;
  return (
    <details className="group">
      <summary className="cursor-pointer list-none rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none [&::-webkit-details-marker]:hidden">
        <span className={cn(base, "group-open:hidden")}>{start} </span>
        <span className="text-xs font-medium text-foreground underline underline-offset-4">
          <span className="group-open:hidden">Show the whole note</span>
          <span className="hidden group-open:inline">Show less</span>
        </span>
      </summary>
      <p className={cn(base, "mt-1")}>{text}</p>
    </details>
  );
}
