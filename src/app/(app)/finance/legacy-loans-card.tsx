"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Money } from "@/components/data/money";
import { useStepUp } from "@/components/step-up/step-up-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { closeLegacyAction } from "./actions";

/** The old manual loans' clearing balance, and the one-off action that books it (research/09). */
export function LegacyLoansCard({
  lentCents,
  repaidCents,
  balanceCents,
  bookedIncomeCents,
  canClose,
}: {
  lentCents: number;
  repaidCents: number;
  balanceCents: number;
  bookedIncomeCents: number;
  canClose: boolean;
}) {
  const router = useRouter();
  const withStepUp = useStepUp();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const income = balanceCents < 0;
  // Repayments refiled elsewhere (e.g. as recoveries) after the close-out: take them back out of the income.
  const correction = !income && bookedIncomeCents >= balanceCents;
  const what = income ? "as income" : correction ? "as a correction" : "as a loss";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Old manual loans (2025–2026)</CardTitle>
        <CardDescription>
          {correction ? (
            <>
              Since they were closed out, <Money cents={balanceCents} /> of payments filed as old-loan repayments has been refiled (e.g. as
              recoveries on a newer loan). Correct the close-out to take it back out of the old loans&rsquo; income.
            </>
          ) : (
            <>
              Lent <Money cents={lentCents} />, repaid <Money cents={repaidCents} />. The <Money cents={Math.abs(balanceCents)} />{" "}
              {income ? "repaid beyond what was lent is their profit" : "never repaid is their loss"}, still waiting in a clearing account.
            </>
          )}
        </CardDescription>
      </CardHeader>
      {canClose ? (
        <CardContent>
          <form method="post"
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              startTransition(async () => {
                const r = await withStepUp(() => closeLegacyAction({ reason }));
                if (!r.ok) return setError(r.error);
                toast.success(`Booked ${what}.`);
                router.refresh();
              });
            }}
            className="space-y-3"
          >
            <Field>
              <FieldLabel htmlFor="legacy-reason">Reason</FieldLabel>
              <Textarea id="legacy-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="e.g. All 2025 manual loans are finished (owner confirmed)" />
              <FieldDescription>
                {correction
                  ? "Reduces legacy loan income, dated with the original close-out."
                  : `Books it as ${income ? "legacy loan income" : "a credit loss"}, dated at the last repayment.`}{" "}
                You&rsquo;ll be asked for your authenticator code.
              </FieldDescription>
            </Field>
            {error ? <FieldError>{error}</FieldError> : null}
            <Button type="submit" disabled={pending || reason.trim().length < 5}>
              {pending ? <Spinner /> : null}
              Book <Money cents={Math.abs(balanceCents)} className="mx-1" /> {what}
            </Button>
          </form>
        </CardContent>
      ) : null}
    </Card>
  );
}
