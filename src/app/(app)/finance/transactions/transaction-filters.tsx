"use client";

import { Search, X } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CATEGORIES, type Category } from "@/domain/ledger/categories";
import { startNavigationProgress } from "@/components/app-shell/navigation-progress";

const GROUPS = [...new Set(Object.values(CATEGORIES).map((c) => c.group))];
const ALL = "__all";

export function TransactionFilters({ q, category, direction }: { q?: string; category?: Category; direction?: "in" | "out" }) {
  const router = useRouter();
  const pathname = usePathname();
  const [text, setText] = useState(q ?? "");

  function apply(patch: Record<string, string | undefined>) {
    const params = new URLSearchParams();
    const merged = { q: text || undefined, category, direction, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) params.set(k, v);
    startNavigationProgress();
    router.push(`${pathname}${params.size ? `?${params}` : ""}`);
  }

  const categoryItems = [{ value: ALL, label: "All categories" }, ...Object.entries(CATEGORIES).map(([value, c]) => ({ value, label: c.label }))];
  const directionItems = [
    { value: ALL, label: "In & out" },
    { value: "in", label: "Money in" },
    { value: "out", label: "Money out" },
  ];

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
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search comment, name, State ID or wallet"
          aria-label="Search transactions"
          className="pl-8"
        />
      </form>
      <Select value={category ?? ALL} onValueChange={(v) => apply({ category: v === ALL ? undefined : String(v) })} items={categoryItems}>
        <SelectTrigger className="sm:w-64" aria-label="Category">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All categories</SelectItem>
          {GROUPS.map((g) => (
            <SelectGroup key={g}>
              <SelectLabel>{g}</SelectLabel>
              {Object.entries(CATEGORIES)
                .filter(([, c]) => c.group === g)
                .map(([value, c]) => (
                  <SelectItem key={value} value={value}>
                    {c.label}
                  </SelectItem>
                ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
      <Select value={direction ?? ALL} onValueChange={(v) => apply({ direction: v === ALL ? undefined : String(v) })} items={directionItems}>
        <SelectTrigger className="sm:w-36" aria-label="Direction">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {directionItems.map((d) => (
            <SelectItem key={d.value} value={d.value}>
              {d.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {q || category || direction ? (
        <Button
          variant="ghost"
          onClick={() => {
            setText("");
            router.push(pathname);
          }}
        >
          <X aria-hidden /> Clear
        </Button>
      ) : null}
    </div>
  );
}
