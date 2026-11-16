"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { linkOfferAction, unlinkOfferAction } from "@/app/(app)/loans/offers/actions";
import { linkQuoteAction, unlinkQuoteAction } from "@/app/(app)/mortgages/quotes/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";

export type MatchCandidate = { id: string; label: string; takenBy: string | null };

/**
 * Corrects the automatic match between an offer and its loan, or a quote and its mortgage
 * (owner review, 2026-10-11): "Not this one" unlinks and remembers; "Link…" picks the right
 * one by hand. Both need a reason, kept in the audit log.
 */
export function MatchControls({
  kind,
  id,
  linked,
  candidates,
}: {
  kind: "offer" | "quote";
  id: string;
  /** What it's linked to now (null when it isn't). */
  linked: string | null;
  candidates: MatchCandidate[];
}) {
  const router = useRouter();
  const noun = kind === "offer" ? "loan" : "mortgage";
  const [open, setOpen] = useState<"unlink" | "link" | null>(null);
  const [choice, setChoice] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const free = candidates.filter((c) => !c.takenBy);

  const submit = () => {
    setError(null);
    startTransition(async () => {
      const r =
        open === "unlink"
          ? kind === "offer"
            ? await unlinkOfferAction({ id, reason })
            : await unlinkQuoteAction({ id, reason })
          : kind === "offer"
            ? await linkOfferAction({ id, loanId: choice, reason })
            : await linkQuoteAction({ id, mortgageId: choice, reason });
      if (!r.ok) return setError(r.error);
      toast.success(open === "unlink" ? `Unlinked. It won’t be matched to that ${noun} again.` : `Linked to the ${noun}.`);
      setOpen(null);
      setReason("");
      setChoice("");
      router.refresh();
    });
  };

  return (
    <>
      {linked ? (
        <Button size="sm" variant="outline" onClick={() => setOpen("unlink")}>
          Not this {noun}
        </Button>
      ) : (
        <Button size="sm" variant="outline" onClick={() => setOpen("link")} disabled={free.length === 0} title={free.length === 0 ? `No unlinked ${noun}s for this person yet` : undefined}>
          Link a {noun}…
        </Button>
      )}
      <Dialog open={open !== null} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{open === "unlink" ? `Not this ${noun}?` : `Link a ${noun} by hand`}</DialogTitle>
            <DialogDescription>
              {open === "unlink"
                ? `It’s linked to ${linked}. Unlinking puts the ${kind} back to waiting, and the app won’t match it to this ${noun} again. You can then link the right one.`
                : `The app links a ${kind} automatically when it can. If it picked nothing, or you unlinked a wrong one, choose the right ${noun} here.`}
            </DialogDescription>
          </DialogHeader>
          <form
            method="post"
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            {open === "link" ? (
              <Field>
                <FieldLabel htmlFor={`${kind}-match`}>{noun === "loan" ? "Loan" : "Mortgage"}</FieldLabel>
                <Select value={choice} onValueChange={(v) => setChoice(String(v))} items={candidates.map((c) => ({ value: c.id, label: c.label }))}>
                  <SelectTrigger id={`${kind}-match`} className="w-full">
                    <SelectValue placeholder={`Choose the ${noun}`} />
                  </SelectTrigger>
                  <SelectContent>
                    {candidates.map((c) => (
                      <SelectItem key={c.id} value={c.id} disabled={Boolean(c.takenBy)}>
                        {c.label}
                        {c.takenBy ? ` (linked to ${c.takenBy})` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            ) : null}
            <Field>
              <FieldLabel htmlFor={`${kind}-match-reason`}>Reason</FieldLabel>
              <Textarea id={`${kind}-match-reason`} rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={open === "unlink" ? "e.g. Two loans the same size; this one was the earlier deal" : "e.g. Paid out a day after the window"} />
              <FieldDescription>Recorded in the audit log.</FieldDescription>
              {error ? <FieldError role="alert">{error}</FieldError> : null}
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(null)}>
                Keep as is
              </Button>
              <Button type="submit" variant={open === "unlink" ? "destructive" : "default"} disabled={pending || reason.trim().length < 5 || (open === "link" && !choice)}>
                {pending ? <Spinner /> : null}
                {open === "unlink" ? "Unlink" : "Link"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
