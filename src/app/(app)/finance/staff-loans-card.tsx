"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Money } from "@/components/data/money";
import { useStepUp } from "@/components/step-up/step-up-provider";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { closeStaffLoansAction } from "./actions";

export type LenderItem = { name: string; lentCents: number; repaidCents: number; balanceCents: number };

/** The old staff loans (account 2200) and the one-off action that clears them (research/11). */
export function StaffLoansCard({ balanceCents, lenders, canClose }: { balanceCents: number; lenders: LenderItem[]; canClose: boolean }) {
  const router = useRouter();
  const withStepUp = useStepUp();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // A one-off clean-up: kept to one line until someone opens it.
  const [open, setOpen] = useState(false);

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Old staff loans</CardTitle>
        <CardDescription>
          The books still show <Money cents={balanceCents} /> owed to staff from loans they made to the company. They&rsquo;re all finished.
        </CardDescription>
        <CardAction>
          <Button size="sm" variant="outline" aria-expanded={open} aria-controls="staff-loans-detail" onClick={() => setOpen((o) => !o)}>
            {open ? "Hide" : canClose ? "Review and clear" : "Details"}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent id="staff-loans-detail" className={open ? "space-y-4" : "hidden"}>
        <ul className="divide-y text-sm">
          {lenders.map((l) => (
            <li key={l.name} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
              <span>
                {l.name}
                <span className="block text-xs text-muted-foreground">
                  Lent <Money cents={l.lentCents} />, repaid <Money cents={l.repaidCents} />
                </span>
              </span>
              <span className="text-right">
                {l.balanceCents > 0 ? (
                  <>
                    <Money cents={l.balanceCents} /> <span className="text-xs text-muted-foreground">settled outside the wallet</span>
                  </>
                ) : l.balanceCents < 0 ? (
                  <>
                    <Money cents={-l.balanceCents} /> <span className="text-xs text-muted-foreground">interest paid to them</span>
                  </>
                ) : (
                  <span className="text-xs text-muted-foreground">Even</span>
                )}
              </span>
            </li>
          ))}
        </ul>
        {canClose ? (
          <form method="post"
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              startTransition(async () => {
                const r = await withStepUp(() => closeStaffLoansAction({ reason }));
                if (!r.ok) return setError(r.error);
                toast.success("Staff loans cleared.");
                router.refresh();
              });
            }}
          >
            <Field>
              <FieldLabel htmlFor="staff-loans-reason">Reason</FieldLabel>
              <Textarea id="staff-loans-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. All staff loans finished and settled (owner)" />
              <FieldDescription>
                One adjustment, dated at the last staff loan: amounts never shown repaid go to capital returned, amounts repaid beyond what was lent go to
                interest. You&rsquo;ll be asked for your authenticator code.
              </FieldDescription>
            </Field>
            {error ? <FieldError>{error}</FieldError> : null}
            <Button type="submit" disabled={pending || reason.trim().length < 5}>
              {pending ? <Spinner /> : null}
              Clear the staff loans
            </Button>
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}
