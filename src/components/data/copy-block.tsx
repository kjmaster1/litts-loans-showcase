"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

/** A block of text (a contract) shown as it will be pasted, with one copy button. */
export function CopyBlock({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
        >
          {copied ? <Check aria-hidden className="text-success" /> : <Copy aria-hidden />}
          {copied ? "Copied" : `Copy ${label}`}
        </Button>
      </div>
      <pre
        tabIndex={0}
        aria-label={label}
        className="max-h-[32rem] overflow-auto rounded-lg border bg-muted/40 p-4 font-sans text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        {text}
      </pre>
    </div>
  );
}
