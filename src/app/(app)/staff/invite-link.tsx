"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { LocalTime } from "@/components/data/local-time";
import { Button } from "@/components/ui/button";

/** Shows a freshly issued invite link exactly once, with copy-to-clipboard. */
export function InviteLink({ url, expiresAt }: { url: string; expiresAt: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="min-w-0 space-y-3">
      <div className="flex min-w-0 items-center gap-2 rounded-lg border bg-muted/50 p-2">
        <code className="ident min-w-0 flex-1 truncate select-all" title={url}>
          {url}
        </code>
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            await navigator.clipboard.writeText(url);
            setCopied(true);
          }}
        >
          {copied ? <Check /> : <Copy />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Send this privately (e.g. a Discord DM). It works once and expires <LocalTime value={expiresAt} format="relative" />.
        It won&rsquo;t be shown again. If it&rsquo;s lost, re-issue the invite from the staff list.
      </p>
    </div>
  );
}
