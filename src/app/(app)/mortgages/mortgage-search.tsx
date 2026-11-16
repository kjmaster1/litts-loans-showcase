"use client";

import { Search, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { startNavigationProgress } from "@/components/app-shell/navigation-progress";

export function MortgageSearch({ q }: { q?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [text, setText] = useState(q ?? "");

  function go(value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set("q", value);
    else next.delete("q");
    startNavigationProgress();
    router.push(`${pathname}${next.size ? `?${next}` : ""}`);
  }

  return (
    <div className="flex gap-2">
      <form method="get"
        role="search"
        className="relative flex-1"
        onSubmit={(e) => {
          e.preventDefault();
          go(text.trim());
        }}
      >
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Address, buyer name or State ID" aria-label="Search mortgages" className="pl-8" />
      </form>
      {q ? (
        <Button
          variant="ghost"
          onClick={() => {
            setText("");
            go("");
          }}
        >
          <X aria-hidden /> Clear
        </Button>
      ) : null}
    </div>
  );
}
