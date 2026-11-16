"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { cancelOfferAction, issueOfferAction } from "./actions";

/** Draft: edit / issue; issued: cancel. */
export function OfferActions({ id, status }: { id: string; status: "draft" | "issued" | "funded" | "cancelled" }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  if (status === "funded" || status === "cancelled") return null;

  return (
    <>
      {status === "draft" ? (
        <>
          <Button variant="outline" render={<Link href={`/loans/new?offer=${id}`} />}>
            Edit
          </Button>
          <Button
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const r = await issueOfferAction(id);
                if (!r.ok) return void toast.error(r.error);
                toast.success("Contract ready to copy.");
                router.refresh();
              })
            }
          >
            {pending ? <Spinner /> : null}
            Issue contract
          </Button>
        </>
      ) : null}
      <Button variant="outline" onClick={() => setOpen(true)}>
        Cancel offer
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Cancel this offer?</DialogTitle>
            <DialogDescription>Use it when the borrower walks away or the terms change (make a new offer for new terms).</DialogDescription>
          </DialogHeader>
          <form
            method="post"
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              startTransition(async () => {
                const r = await cancelOfferAction({ id, reason });
                if (!r.ok) return setError(r.error);
                setOpen(false);
                toast.success("Offer cancelled.");
                router.refresh();
              });
            }}
          >
            <Field>
              <FieldLabel htmlFor="cancel-reason">Reason</FieldLabel>
              <Textarea id="cancel-reason" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Borrower changed their mind" />
              <FieldDescription>Recorded in the audit log.</FieldDescription>
              {error ? <FieldError>{error}</FieldError> : null}
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Keep it
              </Button>
              <Button type="submit" variant="destructive" disabled={pending || reason.trim().length < 3}>
                {pending ? <Spinner /> : null}
                Cancel offer
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
