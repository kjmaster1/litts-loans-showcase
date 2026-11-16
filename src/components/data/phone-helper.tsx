"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

function CopyButton({ text, label, copiedLabel, primary }: { text: string; label: string; copiedLabel: string; primary?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant={primary ? "default" : "outline"}
      size="sm"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      {copied ? copiedLabel : label}
    </Button>
  );
}

/** Pay sheet → phone: the list to paste and the bookmarklet that fills Pay Employee from it (`lib/pay-helper.ts`). */
export function PhoneHelper({ list, bookmarklet }: { list: string | null; bookmarklet: string }) {
  return (
    <div className="space-y-3 px-6 pt-4">
      <div className="flex flex-wrap items-center gap-2">
        {list ? <CopyButton text={list} label="Copy list for the phone" copiedLabel="List copied" primary /> : null}
        <CopyButton text={bookmarklet} label="Copy phone helper" copiedLabel="Helper copied" />
      </div>
      <details className="text-sm text-muted-foreground">
        <summary className="cursor-pointer text-foreground">How to pay with the phone helper</summary>
        <ol className="mt-2 list-decimal space-y-1 pl-5">
          <li>
            Once: <em>Copy phone helper</em>, then in Chrome add a bookmark (right-click the bookmarks bar → Add page), name it
            &ldquo;Litt&rsquo;s pay&rdquo; and paste into its URL.
          </li>
          <li>
            Each pay day: <em>Copy list for the phone</em>. On the phone page open Wallet → the Litt&rsquo;s Loans card, click the bookmark, paste the
            list and press Load list.
          </li>
          <li>
            For each person: the card&rsquo;s ⋯ menu → Pay Employee, then Fill next in the helper. Check the form and press Submit on the phone; the
            helper ticks them off. If the phone shows an error, untick them and try again.
          </li>
        </ol>
        <p className="mt-2">The helper only fills the form: nothing is sent until you press Submit. The next bank import settles what was paid.</p>
      </details>
    </div>
  );
}
