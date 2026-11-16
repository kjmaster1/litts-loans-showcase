"use client";

import { Ban } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { useNow } from "@/hooks/use-now";
import { toLocalInput } from "@/lib/dates";
import { addReadingAction, adoptRuleAction, voidReadingAction } from "./actions";

type Result = { ok: true } | { ok: false; error: string };

function useRun() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const run = (fn: () => Promise<Result>, success: string, after?: () => void) => {
    setError(null);
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) return setError(r.error);
      toast.success(success);
      after?.();
      router.refresh();
    });
  };
  return { run, error, pending };
}

export function AddReadingForm() {
  const { run, error, pending } = useRun();
  const [balance, setBalance] = useState("");
  // Defaults to "now" once hydrated (the server doesn't know the browser's timezone).
  const now = useNow();
  const [whenInput, setWhen] = useState<string | null>(null);
  const when = whenInput ?? (now !== null ? toLocalInput(now) : "");
  const [note, setNote] = useState("");
  const dollars = Number(balance.replace(/[$,\s]/g, ""));
  const valid = balance.trim() !== "" && Number.isInteger(dollars) && when !== "";

  return (
    <form method="post"
      onSubmit={(e) => {
        e.preventDefault();
        run(
          () => addReadingAction({ balanceDollars: dollars, observedAt: new Date(when).toISOString(), note: note.trim() || undefined }),
          "Reading recorded.",
          () => {
            setBalance("");
            setNote("");
            setWhen(null);
          },
        );
      }}
    >
      <FieldGroup className="gap-3">
        <Field>
          <FieldLabel htmlFor="allowance-balance">State Allowance Balance</FieldLabel>
          <Input id="allowance-balance" inputMode="numeric" value={balance} onChange={(e) => setBalance(e.target.value)} placeholder="$796,196" aria-invalid={(balance !== "" && !valid) || undefined} />
          <FieldDescription>Shown at the top of the phone&rsquo;s Business Subscriptions app.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="allowance-when">When you saw it</FieldLabel>
          <Input id="allowance-when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
          <FieldDescription>Your local time. Readings either side of a new mortgage or a payment are the most useful.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="allowance-note">Note (optional)</FieldLabel>
          <Input id="allowance-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Just before 117 Invention Ct was signed" />
        </Field>
        {error ? <FieldError>{error}</FieldError> : null}
        <div>
          <Button type="submit" disabled={pending || !valid}>
            {pending ? <Spinner /> : null}
            Record reading
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}

export function VoidReadingButton({ id, label }: { id: string; label: string }) {
  const { run, error, pending } = useRun();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={<Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={`Void the ${label} reading`} title="Void this reading (if it was entered by mistake)" />}
      >
        <Ban aria-hidden />
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Void this reading?</DialogTitle>
          <DialogDescription>
            Only do this if the {label} reading was entered by mistake. It stays on record, marked void, and stops counting.
          </DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor={`void-${id}`}>Reason</FieldLabel>
          <Textarea id={`void-${id}`} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="e.g. Typo, missed a digit" />
        </Field>
        {error ? <FieldError>{error}</FieldError> : null}
        <DialogFooter>
          <Button variant="destructive" disabled={pending || reason.trim().length < 5} onClick={() => run(() => voidReadingAction({ id, reason }), "Reading voided.", () => setOpen(false))}>
            {pending ? <Spinner /> : null}
            Void reading
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const NONE = "__none";

export function AdoptRuleForm({ rules, current, suggested }: { rules: { id: string; label: string }[]; current: string | null; suggested: string | null }) {
  const { run, error, pending } = useRun();
  const [choice, setChoice] = useState(current ?? suggested ?? NONE);
  const [reason, setReason] = useState("");
  const items = [{ value: NONE, label: "No rule (don't project)" }, ...rules.map((r) => ({ value: r.id, label: r.label }))];
  return (
    <form method="post"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => adoptRuleAction({ ruleId: choice === NONE ? null : choice, reason }), "Rule saved.", () => setReason(""));
      }}
    >
      <FieldGroup className="gap-3">
        <Field>
          <FieldLabel htmlFor="rule">Rule to use</FieldLabel>
          <Select value={choice} onValueChange={(v) => setChoice(String(v))} items={items}>
            <SelectTrigger id="rule" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {items.map((i) => (
                <SelectItem key={i.value} value={i.value}>
                  {i.label}
                  {i.value === suggested ? " (best fit)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="rule-reason">Reason</FieldLabel>
          <Input id="rule-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Matches the last four readings exactly" />
        </Field>
        {error ? <FieldError>{error}</FieldError> : null}
        <div>
          <Button type="submit" variant="outline" disabled={pending || reason.trim().length < 5 || choice === (current ?? NONE)}>
            {pending ? <Spinner /> : null}
            Use this rule
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}
