"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { clearDoNotLendAction, setDoNotLendAction } from "../actions";

/** Mark or clear "do not lend" on a borrower (Management+), with a reason. */
export function DoNotLend({ stateId, flagged }: { stateId: number; flagged: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!open) {
    return (
      <Button size="sm" variant={flagged ? "outline" : "destructive"} onClick={() => setOpen(true)}>
        {flagged ? "Clear do not lend" : "Mark do not lend"}
      </Button>
    );
  }
  return (
    <form method="post"
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        startTransition(async () => {
          const r = await (flagged ? clearDoNotLendAction : setDoNotLendAction)({ stateId, reason });
          if (!r.ok) return setError(r.error);
          toast.success(flagged ? "Flag cleared." : "Marked do not lend.");
          setOpen(false);
          setReason("");
          router.refresh();
        });
      }}
    >
      <Field>
        <FieldLabel htmlFor="dnl-reason">{flagged ? "Why can we lend to them again?" : "Why not lend to them?"}</FieldLabel>
        <Input id="dnl-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={flagged ? "e.g. Settled the old debt in full" : "e.g. Defaulted twice, ignored contact"} autoFocus />
      </Field>
      {error ? <FieldError>{error}</FieldError> : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant={flagged ? "default" : "destructive"} disabled={pending || reason.trim().length < 5}>
          {pending ? <Spinner /> : null}
          {flagged ? "Clear flag" : "Mark do not lend"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
