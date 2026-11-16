"use client";

import { ArrowRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { LocalTime } from "@/components/data/local-time";
import { Money } from "@/components/data/money";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { relinkAction } from "../actions";

export type MoveView = { txId: string; at: string; what: string; amountCents: number; from: string; to: string };

/** Proposed corrections for a borrower whose payments sit on the wrong loan. Management+. */
export function RelinkPanel({ stateId, moves }: { stateId: number; moves: MoveView[] }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <Card className="border-warning/40">
      <CardHeader>
        <CardTitle>Payments may be on the wrong loan</CardTitle>
        <CardDescription>
          This borrower had more than one loan, and {moves.length} payment{moves.length === 1 ? " looks" : "s look"} recorded against the wrong one. Applying
          moves them, re-reads the phone cards against the corrected loans and recalculates the State&rsquo;s share. Cash isn&rsquo;t affected.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="divide-y rounded-lg border text-sm">
          {moves.map((m) => (
            <li key={m.txId} className="flex flex-wrap items-center gap-x-2 gap-y-1 p-3">
              <span className="text-muted-foreground">
                <LocalTime value={m.at} format="date" />
              </span>
              <span className="font-medium">{m.what}</span>
              <Money cents={m.amountCents} />
              <span className="flex w-full items-center gap-1 text-xs text-muted-foreground">
                {m.from} <ArrowRight className="size-3" aria-label="to" /> <span className="text-foreground">{m.to}</span>
              </span>
            </li>
          ))}
        </ul>
        <form method="post"
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            startTransition(async () => {
              const r = await relinkAction({ stateId, reason });
              if (!r.ok) return setError(r.error);
              toast.success(`Moved ${r.data.moved} payment${r.data.moved === 1 ? "" : "s"}${r.data.termsCorrected ? `; corrected terms on ${r.data.termsCorrected} loan${r.data.termsCorrected === 1 ? "" : "s"}` : ""}.`);
              router.refresh();
            });
          }}
        >
          <Field>
            <FieldLabel htmlFor="relink-reason">Reason</FieldLabel>
            <Textarea id="relink-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="e.g. Two loans at once; payments matched to the wrong one" />
            <FieldDescription>Recorded in the audit log and on both loans.</FieldDescription>
          </Field>
          {error ? <FieldError>{error}</FieldError> : null}
          <Button type="submit" disabled={pending || reason.trim().length < 5}>
            {pending ? <Spinner /> : null}
            Apply corrections
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
