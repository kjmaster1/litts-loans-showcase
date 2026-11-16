"use client";

import { Search, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Search box for a server-rendered list: filters as you type (after a short pause),
 * keeps the page's other parameters and is reachable with "/" (data-list-search).
 */
export function ListSearch({ q, label, placeholder, param = "q" }: { q: string; label: string; placeholder: string; param?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [text, setText] = useState(q);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => {
      const next = new URLSearchParams(params);
      if (text.trim()) next.set(param, text.trim());
      else next.delete(param);
      next.delete("page");
      router.replace(`${pathname}${next.size ? `?${next}` : ""}`, { scroll: false });
    }, 250);
    return () => clearTimeout(t);
    // Only the text drives this; params/pathname are read at the time of the change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  return (
    <form method="get" role="search" className="relative flex-1" onSubmit={(e) => e.preventDefault()}>
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <Input
        name={param}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        data-list-search
        autoComplete="off"
        className="pr-8 pl-8"
      />
      {text ? (
        <Button type="button" size="icon-xs" variant="ghost" aria-label="Clear search" className="absolute top-1/2 right-1.5 -translate-y-1/2" onClick={() => setText("")}>
          <X aria-hidden />
        </Button>
      ) : null}
    </form>
  );
}
