"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import type { ConfirmView } from "@/domain/mortgages/allowance-outlook";
import { useNow } from "@/hooks/use-now";
import { toLocalInput } from "@/lib/dates";
import { formatCents } from "@/lib/format";
import { cn } from "@/lib/utils";
import { confirmQuoteAction, previewConfirmAction } from "./actions";
import { AllowanceWorking, hasWarning, VerdictAlert } from "./allowance-working";

/**
 * "Confirm — buyer is going ahead" (research/19 §4, mockup): the signing time, and the State allowance on that day
 * worked out on the server as the time changes. A shortfall warns; it never blocks (research/04).
 */

export type ConfirmQuote = {
  id: string;
  number: number;
  address: string;
  buyerName: string;
  loanCents: number;
  companyFunded: boolean;
  /** ISO; prefills the field. */
  expectedSigningAt: string | null;
};

/** The server refuses a signing time more than this far in the past (clock skew, as allowance readings). */
const SKEW_MS = 5 * 60_000;
const PREVIEW_DELAY_MS = 300;

type Preview = { when: string; view: ConfirmView | null; error: string | null };

function ConfirmForm({ quote, onDone, onCancel }: { quote: ConfirmQuote; onDone: () => void; onCancel: () => void }) {
  const router = useRouter();
  const now = useNow();
  const [when, setWhen] = useState(() => (quote.expectedSigningAt ? toLocalInput(Date.parse(quote.expectedSigningAt)) : ""));
  const [changed, setChanged] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const latest = useRef(0);
  const [timeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);

  const atMs = when ? new Date(when).getTime() : Number.NaN;
  const valid = Number.isFinite(atMs);
  const past = valid && now !== null && atMs < now - SKEW_MS;
  const wanted = valid && !past && !quote.companyFunded;

  // Debounced; a slower earlier answer never replaces a newer one (`latest`).
  useEffect(() => {
    if (!wanted) return;
    const ticket = ++latest.current;
    const timer = setTimeout(async () => {
      let next: Preview;
      try {
        const r = await previewConfirmAction({ id: quote.id, expectedSigningAt: new Date(when).toISOString() });
        next = r.ok ? { when, view: r.data, error: null } : { when, view: null, error: r.error };
      } catch {
        next = { when, view: null, error: "the server didn’t answer" };
      }
      if (ticket !== latest.current) return;
      setPreview(next);
    }, PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [wanted, when, quote.id]);

  const current = preview !== null && preview.when === when;
  const loading = wanted && !current;
  const view = preview?.view ?? null;
  const warn = current && view !== null && hasWarning(view);

  return (
    <form
      method="post"
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid || past) return;
        setError(null);
        startTransition(async () => {
          const r = await confirmQuoteAction({ id: quote.id, expectedSigningAt: new Date(when).toISOString() });
          if (!r.ok) return setError(r.error);
          onDone();
          toast.success(`Quote #${quote.number} confirmed.`);
          router.refresh();
        });
      }}
    >
      <Field>
        <FieldLabel htmlFor="confirm-signing">Expected signing: when the bidding closes</FieldLabel>
        <Input
          id="confirm-signing"
          type="datetime-local"
          className="w-fit"
          value={when}
          min={now !== null ? toLocalInput(now) : undefined}
          required
          aria-invalid={past || undefined}
          onChange={(e) => {
            setWhen(e.target.value);
            setChanged(true);
          }}
        />
        {past ? <FieldError>That time has passed. Set when the bidding closes now.</FieldError> : <FieldDescription>Your time ({timeZone}).</FieldDescription>}
      </Field>

      {quote.companyFunded ? (
        <p className="text-sm text-muted-foreground">Company-funded: it doesn&rsquo;t use the State allowance.</p>
      ) : !valid || past ? (
        <p className="text-sm text-muted-foreground">Set the signing time to see the State allowance on the day.</p>
      ) : view ? (
        <div className={cn("space-y-3 transition-opacity", loading && "opacity-60")} aria-busy={loading || undefined}>
          <AllowanceWorking view={view} />
          <VerdictAlert view={view} context="dialog" announce={changed} />
        </div>
      ) : loading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Working out the allowance on that day…
        </p>
      ) : preview?.error ? (
        <p className="text-sm text-muted-foreground">The allowance couldn&rsquo;t be worked out ({preview.error}). You can still confirm the quote.</p>
      ) : (
        <p className="text-sm text-muted-foreground">No State allowance reading yet, so there&rsquo;s nothing to project from.</p>
      )}

      {error ? <FieldError>{error}</FieldError> : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending || !valid || past || loading}>
          {pending ? <Spinner /> : null}
          {warn ? "Confirm anyway" : "Confirm"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function ConfirmQuoteDialog({ quote, open, onOpenChange }: { quote: ConfirmQuote; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Confirm quote #{quote.number}</DialogTitle>
          <DialogDescription>
            {quote.address} · {quote.buyerName} · loan {formatCents(quote.loanCents)}
          </DialogDescription>
        </DialogHeader>
        {/* The popup unmounts when closed, so each opening starts from the quote's own signing time. */}
        <ConfirmForm quote={quote} onDone={() => onOpenChange(false)} onCancel={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
