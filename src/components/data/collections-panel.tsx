"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { LongText } from "./long-text";
import { LocalTime } from "@/components/data/local-time";
import { Money } from "@/components/data/money";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { logCollectionAction } from "@/app/(app)/loans/actions";
import { StatusBadge } from "./status-badge";

export type CollectionItem = {
  id: string;
  at: string;
  kind: string;
  note: string;
  promiseCents: number | null;
  promiseBy: string | null;
  nextActionAt: string | null;
  staffName: string;
  outcome: { state: "kept" | "broken" | "pending"; paidCents: number } | null;
};

const KINDS = [
  { value: "contacted", label: "Spoke to them" },
  { value: "no_answer", label: "No answer" },
  { value: "promise", label: "Promised to pay" },
  { value: "handed_to_legal", label: "Handed to Legal" },
  { value: "seizure", label: "Seizure / repossession" },
  { value: "note", label: "Note" },
];
const LABEL = Object.fromEntries(KINDS.map((k) => [k.value, k.label]));
/** Today in the UK, as a date input value. */
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

const OUTCOME = {
  kept: { tone: "success", label: "Kept" },
  pending: { tone: "neutral", label: "Not due yet" },
  broken: { tone: "danger", label: "Broken" },
} as const;

/** Collections log on an overdue, defaulted or written-off loan, or a late mortgage (research/11–12). */
export function CollectionsPanel({ target, items, canLog }: { target: { loanId: string } | { mortgageId: string }; items: CollectionItem[]; canLog: boolean }) {
  const router = useRouter();
  const [kind, setKind] = useState("contacted");
  const [note, setNote] = useState("");
  const [amount, setAmount] = useState("");
  const [promiseBy, setPromiseBy] = useState("");
  const [next, setNext] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const next0 = items[0]?.nextActionAt;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Collections</CardTitle>
        <CardDescription>
          {next0 ? (
            <>
              Next follow-up <LocalTime value={next0} format="date" />.
            </>
          ) : items.length ? (
            "No follow-up date set."
          ) : (
            "Nothing logged yet. Record each contact so anyone can pick the case up."
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {canLog ? (
          <form method="post"
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              startTransition(async () => {
                const r = await logCollectionAction({
                  ...target,
                  kind: kind as never,
                  note,
                  promiseDollars: kind === "promise" && amount ? Number(amount.replace(/[$,\s]/g, "")) : null,
                  promiseBy: kind === "promise" && promiseBy ? promiseBy : null,
                  nextActionAt: next || null,
                });
                if (!r.ok) return setError(r.error);
                toast.success("Logged.");
                setNote("");
                setAmount("");
                setPromiseBy("");
                setNext("");
                router.refresh();
              });
            }}
          >
            <Field>
              <FieldLabel htmlFor="coll-kind">What happened</FieldLabel>
              <Select value={kind} onValueChange={(v) => setKind(String(v))} items={KINDS}>
                <SelectTrigger id="coll-kind" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KINDS.map((k) => (
                    <SelectItem key={k.value} value={k.value}>
                      {k.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {kind === "promise" ? (
              <div className="grid grid-cols-2 gap-3">
                <Field>
                  <FieldLabel htmlFor="coll-amount">Amount ($)</FieldLabel>
                  <Input id="coll-amount" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 5000" />
                </Field>
                <Field>
                  <FieldLabel htmlFor="coll-by">By</FieldLabel>
                  <Input id="coll-by" type="date" min={today()} value={promiseBy} onChange={(e) => setPromiseBy(e.target.value)} />
                </Field>
              </div>
            ) : null}
            <Field>
              <FieldLabel htmlFor="coll-note">Note</FieldLabel>
              <Textarea id="coll-note" rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Called at the bank; says paid Friday" />
            </Field>
            <Field>
              <FieldLabel htmlFor="coll-next">Follow up on</FieldLabel>
              <Input id="coll-next" type="date" min={today()} value={next} onChange={(e) => setNext(e.target.value)} />
              <FieldDescription>{kind === "promise" ? "Leave empty to follow up on the promised date." : "Optional. Shows on the collections list when it's due."}</FieldDescription>
            </Field>
            {error ? <FieldError>{error}</FieldError> : null}
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? <Spinner /> : null}
              Log it
            </Button>
          </form>
        ) : null}
        {items.length ? (
          <ol className="space-y-3 border-t pt-3 text-sm">
            {items.map((i) => (
              <li key={i.id}>
                <div className="font-medium">
                  {LABEL[i.kind] ?? i.kind}
                  {i.promiseCents ? (
                    <>
                      {" "}
                      · <Money cents={i.promiseCents} /> by <LocalTime value={i.promiseBy} format="date" />
                    </>
                  ) : null}
                  {i.outcome ? (
                    <StatusBadge tone={OUTCOME[i.outcome.state].tone} className="ml-2 align-middle">
                      {OUTCOME[i.outcome.state].label}
                    </StatusBadge>
                  ) : null}
                </div>
                {i.outcome && i.outcome.state !== "kept" && i.outcome.paidCents > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    <Money cents={i.outcome.paidCents} /> paid since the promise.
                  </p>
                ) : null}
                {i.note ? <LongText className="text-muted-foreground" text={i.note} /> : null}
                <div className="text-xs text-muted-foreground">
                  <LocalTime value={i.at} /> · {i.staffName}
                  {i.nextActionAt ? (
                    <>
                      {" "}
                      · follow up <LocalTime value={i.nextActionAt} format="date" />
                    </>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        ) : null}
      </CardContent>
    </Card>
  );
}
