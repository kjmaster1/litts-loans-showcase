"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { startNavigationProgress } from "@/components/app-shell/navigation-progress";

/** Date range (UK calendar dates, inclusive) with quick presets. */
export function RangeForm({ report, from, to, presets }: { report: string; from: string; to: string; presets: { label: string; from: string; to: string }[] }) {
  const router = useRouter();
  const [f, setF] = useState(from);
  const [t, setT] = useState(to);
  const go = (a: string, b: string) => {
    startNavigationProgress();
    router.push(`/finance/reports?${new URLSearchParams({ report, from: a, to: b })}`);
  };

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
      <form method="get"
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          go(f, t);
        }}
      >
        <div className="space-y-1">
          <Label htmlFor="from">From</Label>
          <Input id="from" type="date" value={f} max={t} onChange={(e) => setF(e.target.value)} className="w-40" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="to">To</Label>
          <Input id="to" type="date" value={t} min={f} onChange={(e) => setT(e.target.value)} className="w-40" />
        </div>
        <Button type="submit" variant="outline">
          Show
        </Button>
      </form>
      <div className="flex flex-wrap gap-1">
        {presets.map((p) => (
          <Button
            key={p.label}
            size="sm"
            variant={p.from === from && p.to === to ? "secondary" : "ghost"}
            onClick={() => {
              setF(p.from);
              setT(p.to);
              go(p.from, p.to);
            }}
          >
            {p.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
