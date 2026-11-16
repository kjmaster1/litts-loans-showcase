"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { useNow } from "@/hooks/use-now";
import { toLocalInput } from "@/lib/dates";
import { cancelQuoteAction, markQuoteSignedAction, unconfirmQuoteAction } from "./actions";
import { ConfirmQuoteDialog, type ConfirmQuote } from "./confirm-dialog";
import { signingTimeHref } from "./status";

/** A live quote as its actions need it (dates as ISO strings). */
export type ActionQuote = ConfirmQuote & { status: "draft" | "confirmed"; signedAt: string | null };

/** The server accepts a signed time up to this far ahead (clock skew). */
const SKEW_MS = 5 * 60_000;

function CancelQuoteDialog({ id, open, onOpenChange }: { id: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Cancel this quote?</DialogTitle>
          <DialogDescription>Use it when the buyer walks away. A cancelled quote isn&rsquo;t matched to a mortgage.</DialogDescription>
        </DialogHeader>
        <form
          method="post"
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            startTransition(async () => {
              const r = await cancelQuoteAction({ id, reason });
              if (!r.ok) return setError(r.error);
              onOpenChange(false);
              toast.success("Quote cancelled.");
              router.refresh();
            });
          }}
        >
          <Field>
            <FieldLabel htmlFor="cancel-reason">Reason</FieldLabel>
            <Textarea id="cancel-reason" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Buyer chose a cash purchase" />
            <FieldDescription>Recorded in the audit log.</FieldDescription>
            {error ? <FieldError>{error}</FieldError> : null}
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Keep it
            </Button>
            <Button type="submit" variant="destructive" disabled={pending || reason.trim().length < 3}>
              {pending ? <Spinner /> : null}
              Cancel quote
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SignedForm({ quote, onDone, onCancel }: { quote: ActionQuote; onDone: () => void; onCancel: () => void }) {
  const router = useRouter();
  // The dialog only opens after hydration, so `now` is set.
  const now = useNow() ?? 0;
  const expected = quote.expectedSigningAt ? Date.parse(quote.expectedSigningAt) : null;
  // The expected signing time once it has passed, else now.
  const [when, setWhen] = useState(() => toLocalInput(expected !== null && expected <= now ? expected : now));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const atMs = when ? new Date(when).getTime() : Number.NaN;
  const valid = Number.isFinite(atMs);
  const future = valid && atMs > now + SKEW_MS;
  const [timeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);

  return (
    <form
      method="post"
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid || future) return;
        setError(null);
        startTransition(async () => {
          const r = await markQuoteSignedAction({ id: quote.id, signedAt: new Date(when).toISOString() });
          if (!r.ok) return setError(r.error);
          onDone();
          toast.success(`Quote #${quote.number} marked signed in game.`);
          router.refresh();
        });
      }}
    >
      <Field>
        <FieldLabel htmlFor="signed-at">When it was signed</FieldLabel>
        <Input id="signed-at" type="datetime-local" className="w-fit" value={when} max={toLocalInput(now)} required aria-invalid={future || undefined} onChange={(e) => setWhen(e.target.value)} />
        {future ? <FieldError>That time is in the future.</FieldError> : <FieldDescription>Your time ({timeZone}).</FieldDescription>}
      </Field>
      {error ? <FieldError>{error}</FieldError> : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending || !valid || future}>
          {pending ? <Spinner /> : null}
          Mark signed
        </Button>
      </DialogFooter>
    </form>
  );
}

function SignedInGameDialog({ quote, open, onOpenChange }: { quote: ActionQuote; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Quote #{quote.number} signed in game?</DialogTitle>
          <DialogDescription>
            For when the sale has gone through but its tablet agreement isn&rsquo;t pasted yet. The allowance outlook then treats it as a mortgage that has started; the quote links
            itself once the agreement is pasted.
          </DialogDescription>
        </DialogHeader>
        <SignedForm quote={quote} onDone={() => onOpenChange(false)} onCancel={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function BackToDraftDialog({ quote, open, onOpenChange }: { quote: ActionQuote; open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Move quote #{quote.number} back to draft?</DialogTitle>
          <DialogDescription>
            It stops drawing on the State allowance. Its signing time is kept for when you confirm it again.
            {quote.signedAt ? " The “signed in game” mark is cleared too." : ""}
          </DialogDescription>
        </DialogHeader>
        <form
          method="post"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            startTransition(async () => {
              const r = await unconfirmQuoteAction({ id: quote.id });
              if (!r.ok) return setError(r.error);
              onOpenChange(false);
              toast.success(`Quote #${quote.number} is a draft again.`);
              router.refresh();
            });
          }}
        >
          {error ? <FieldError className="mb-4">{error}</FieldError> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Keep it confirmed
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? <Spinner /> : null}
              Back to draft
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type Open = "confirm" | "signed" | "draft" | "cancel" | null;

/** The page header's actions for a live quote the viewer may change. */
export function QuoteActions({ quote }: { quote: ActionQuote }) {
  const [open, setOpen] = useState<Open>(null);
  const toggle = (which: Exclude<Open, null>) => (next: boolean) => setOpen(next ? which : null);
  return (
    <>
      {quote.status === "draft" ? (
        <Button onClick={() => setOpen("confirm")}>Confirm — buyer is going ahead</Button>
      ) : (
        <>
          {quote.signedAt ? null : <Button onClick={() => setOpen("signed")}>Signed in game</Button>}
          <Button variant="outline" onClick={() => setOpen("draft")}>
            Back to draft
          </Button>
        </>
      )}
      <Button variant="outline" render={<Link href={`/mortgages/quotes/${quote.id}/edit`} />}>
        Edit
      </Button>
      <Button variant="outline" onClick={() => setOpen("cancel")}>
        Cancel quote
      </Button>
      {quote.status === "draft" ? <ConfirmQuoteDialog quote={quote} open={open === "confirm"} onOpenChange={toggle("confirm")} /> : null}
      {quote.status === "confirmed" ? (
        <>
          <SignedInGameDialog quote={quote} open={open === "signed"} onOpenChange={toggle("signed")} />
          <BackToDraftDialog quote={quote} open={open === "draft"} onOpenChange={toggle("draft")} />
        </>
      ) : null}
      <CancelQuoteDialog id={quote.id} open={open === "cancel"} onOpenChange={toggle("cancel")} />
    </>
  );
}

/** The answers to "Signing time passed: did it sign?" on a confirmed quote. */
export function SigningPassedActions({ quote }: { quote: ActionQuote }) {
  const [open, setOpen] = useState<"signed" | "cancel" | null>(null);
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      <Button size="sm" onClick={() => setOpen("signed")}>
        Yes, signed in game
      </Button>
      <Button size="sm" variant="outline" className="bg-background" render={<Link href={signingTimeHref(quote.id)} />}>
        Move the signing time
      </Button>
      <Button size="sm" variant="outline" className="bg-background" onClick={() => setOpen("cancel")}>
        No, cancel the quote
      </Button>
      <SignedInGameDialog quote={quote} open={open === "signed"} onOpenChange={(next) => setOpen(next ? "signed" : null)} />
      <CancelQuoteDialog id={quote.id} open={open === "cancel"} onOpenChange={(next) => setOpen(next ? "cancel" : null)} />
    </div>
  );
}
