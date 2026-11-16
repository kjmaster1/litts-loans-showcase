"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** A value with a one-click copy button — for pasting into the game. */
export function CopyValue({ value, display, label, className }: { value: string; display?: React.ReactNode; label: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1", className)}>
      <span className="min-w-0 truncate" title={value}>
        {display ?? value}
      </span>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={copied ? `${label} copied` : `Copy ${label}`}
        title={copied ? "Copied" : `Copy ${label}`}
        onClick={async () => {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check className="text-success" /> : <Copy />}
      </Button>
    </span>
  );
}
