"use client";

import { Search, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { startNavigationProgress } from "@/components/app-shell/navigation-progress";

const ALL = "__all";

export function LoanFilters({ q, officer, staff }: { q?: string; officer?: string; staff: { id: string; name: string }[] | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [text, setText] = useState(q ?? "");

  function apply(patch: Record<string, string | undefined>) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries({ q: text || undefined, ...patch })) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    startNavigationProgress();
    router.push(`${pathname}${next.size ? `?${next}` : ""}`);
  }

  const officerItems = staff
    ? [
        { value: ALL, label: "All officers" },
        { value: "mine", label: "My loans" },
        { value: "unassigned", label: "Unassigned" },
        ...staff.map((s) => ({ value: s.id, label: s.name })),
      ]
    : [];

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <form method="get"
        role="search"
        className="relative flex-1"
        onSubmit={(e) => {
          e.preventDefault();
          apply({ q: text || undefined });
        }}
      >
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Borrower name or State ID" aria-label="Search loans" className="pl-8" />
      </form>
      {staff ? (
        <Select value={officer ?? ALL} onValueChange={(v) => apply({ officer: v === ALL ? undefined : String(v) })} items={officerItems}>
          <SelectTrigger className="sm:w-56" aria-label="Officer">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {officerItems.slice(0, 3).map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
            {staff.length ? <SelectSeparator /> : null}
            {officerItems.slice(3).map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      {q || officer ? (
        <Button
          variant="ghost"
          onClick={() => {
            setText("");
            apply({ q: undefined, officer: undefined });
          }}
        >
          <X aria-hidden /> Clear
        </Button>
      ) : null}
    </div>
  );
}
