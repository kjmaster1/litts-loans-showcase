"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { LocalTime } from "@/components/data/local-time";
import { Money } from "@/components/data/money";
import { StatusBadge, type Tone } from "@/components/data/status-badge";
import { startNavigationProgress } from "@/components/app-shell/navigation-progress";
import { useStepUp } from "@/components/step-up/step-up-provider";
import { useNow } from "@/hooks/use-now";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { addCollateralAction, addNoteAction, assignOfficerAction, markRepaidAction, retireCardOnlyLoanAction, setCollateralStatusAction, writeOffAction } from "../actions";

type Result = { ok: true } | { ok: false; error: string };

/** Runs a Server Action, shows its error inline, and refreshes the page on success. */
function useRun() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const run = (fn: () => Promise<Result>, success: string, after?: () => void) => {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) return setError(result.error);
      toast.success(success);
      after?.();
      router.refresh();
    });
  };
  return { run, error, pending };
}

const NONE = "__none";

export function OfficerPanel({
  loanId,
  officer,
  staff,
  viewer,
}: {
  loanId: string;
  officer: { id: string; name: string } | null;
  staff: { id: string; name: string }[] | null;
  viewer: { id: string; name: string };
}) {
  const { run, error, pending } = useRun();
  const [choice, setChoice] = useState(officer?.id ?? NONE);
  const [reason, setReason] = useState("");
  const [editing, setEditing] = useState(officer === null);
  const changing = officer !== null && choice !== officer.id;
  const items = staff ? [{ value: NONE, label: "Unassigned" }, ...staff.map((s) => ({ value: s.id, label: s.name }))] : [];

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Loan officer</CardTitle>
        <CardDescription className={officer ? "text-sm font-medium text-foreground" : undefined}>{officer ? officer.name : "Nobody is looking after this loan yet."}</CardDescription>
        {staff && officer && !editing ? (
          <CardAction>
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
              Change
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className={staff && officer && !editing ? "hidden" : undefined}>
        {staff ? (
          <form method="post"
            onSubmit={(e) => {
              e.preventDefault();
              run(
                () => assignOfficerAction({ loanId, officerStaffId: choice === NONE ? null : choice, reason: reason.trim() || undefined }),
                "Officer updated.",
                () => setReason(""),
              );
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="officer">Officer</FieldLabel>
                <Select value={choice} onValueChange={(v) => setChoice(String(v))} items={items}>
                  <SelectTrigger id="officer" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {items.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              {changing ? (
                <Field>
                  <FieldLabel htmlFor="officer-reason">Reason for the change</FieldLabel>
                  <Input id="officer-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Officer left the company" />
                </Field>
              ) : null}
              {error ? <FieldError>{error}</FieldError> : null}
              <div className="flex gap-2">
                <Button type="submit" variant="outline" disabled={pending || choice === (officer?.id ?? NONE) || (changing && reason.trim().length < 5)}>
                  {pending ? <Spinner /> : null}
                  Save
                </Button>
                {officer ? (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setEditing(false);
                      setChoice(officer.id);
                      setReason("");
                    }}
                  >
                    Cancel
                  </Button>
                ) : null}
              </div>
            </FieldGroup>
          </form>
        ) : !officer ? (
          <div className="space-y-2">
            <Button variant="outline" disabled={pending} onClick={() => run(() => assignOfficerAction({ loanId, officerStaffId: viewer.id }), "This loan is now yours.")}>
              {pending ? <Spinner /> : null}
              Claim as mine
            </Button>
            {error ? <FieldError>{error}</FieldError> : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function WriteOffPanel({
  loanId,
  status,
  outstandingCents,
  eligibleAt,
  writtenOffAt,
}: {
  loanId: string;
  status: "defaulted" | "written_off";
  outstandingCents: number | null;
  eligibleAt: string | null;
  writtenOffAt: string | null;
}) {
  const withStepUp = useStepUp();
  const { run, error, pending } = useRun();
  const [reason, setReason] = useState("");
  const now = useNow();
  // The server re-checks eligibility; this only decides what to show.
  const eligible = eligibleAt !== null && now !== null && Date.parse(eligibleAt) <= now;

  if (status === "written_off") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Written off</CardTitle>
          <CardDescription>
            Charged off <LocalTime value={writtenOffAt} />. Anything the borrower pays from now on is booked as a recovery.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card className="border-danger/30">
      <CardHeader>
        <CardTitle>Write off</CardTitle>
        <CardDescription>
          Moves what&rsquo;s still owed{outstandingCents !== null ? (
            <>
              {" "}
              (<Money cents={outstandingCents} />)
            </>
          ) : null}{" "}
          to credit losses. The loan stays on record and later payments count as recoveries.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!eligible ? (
          <p className="text-sm text-muted-foreground">
            Available from {eligibleAt ? <LocalTime value={eligibleAt} format="date" /> : "28 days after the loan defaults"}.
          </p>
        ) : (
          <form method="post"
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                const r = await withStepUp(() => writeOffAction({ loanId, reason }));
                return r.ok ? { ok: true } : r;
              }, "Loan written off.");
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="writeoff-reason">Reason</FieldLabel>
                <Textarea
                  id="writeoff-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={2}
                  placeholder="e.g. Borrower unreachable for 6 weeks; collateral sold"
                />
                <FieldDescription>Recorded in the audit log. You&rsquo;ll be asked for an authenticator code.</FieldDescription>
              </Field>
              {error ? <FieldError>{error}</FieldError> : null}
              <div>
                <Button type="submit" variant="destructive" disabled={pending || reason.trim().length < 5}>
                  {pending ? <Spinner /> : null}
                  Write off loan
                </Button>
              </div>
            </FieldGroup>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

const REMOVE = "__remove";

/** Management+: retire a loan known only from a phone card — merge it into the real one, or retire it as a mistake (step-up + reason). */
export function RetireCardOnlyLoanPanel({ loanId, targets }: { loanId: string; targets: { id: string; label: string }[] }) {
  const router = useRouter();
  const withStepUp = useStepUp();
  const [open, setOpen] = useState(false);
  const [into, setInto] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const items = [...targets.map((t) => ({ value: t.id, label: `Same as the ${t.label}` })), { value: REMOVE, label: "Added by mistake: retire it" }];

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Known only from a phone card</CardTitle>
        <CardDescription>No bank disbursement matches this loan. If it duplicates another loan, or shouldn&rsquo;t exist, retire it here.</CardDescription>
        {!open ? (
          <CardAction>
            <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
              Retire…
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      {open ? (
        <CardContent>
          <form
            method="post"
            onSubmit={(e) => {
              e.preventDefault();
              if (!into) return;
              setError(null);
              startTransition(async () => {
                const r = await withStepUp(() => retireCardOnlyLoanAction({ loanId, intoLoanId: into === REMOVE ? null : into, reason }));
                if (!r.ok) return setError(r.error);
                toast.success(into === REMOVE ? "Loan retired." : "Merged into the other loan.");
                startNavigationProgress();
                router.push(into === REMOVE ? "/loans" : `/loans/${into}`);
              });
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="retire-choice">What is it?</FieldLabel>
                <Select value={into ?? ""} onValueChange={(v) => setInto(v ? String(v) : null)} items={items}>
                  <SelectTrigger id="retire-choice" className="w-full">
                    <SelectValue placeholder="Choose" />
                  </SelectTrigger>
                  <SelectContent>
                    {items.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>Merging moves its phone cards, collateral and offer to that loan.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="retire-reason">Reason</FieldLabel>
                <Textarea id="retire-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="e.g. Same card pasted twice" />
                <FieldDescription>It disappears from every list; its history is kept. Recorded in the audit log. You&rsquo;ll be asked for an authenticator code.</FieldDescription>
              </Field>
              {error ? <FieldError>{error}</FieldError> : null}
              <div className="flex gap-2">
                <Button type="submit" variant="destructive" disabled={pending || !into || reason.trim().length < 5}>
                  {pending ? <Spinner /> : null}
                  {into === REMOVE ? "Retire" : "Merge"}
                </Button>
                <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
                  Cancel
                </Button>
              </div>
            </FieldGroup>
          </form>
        </CardContent>
      ) : null}
    </Card>
  );
}

const COLLATERAL: Record<string, { label: string; tone: Tone }> = {
  held: { label: "Held", tone: "info" },
  repossessed: { label: "Repossessed", tone: "warning" },
  sold: { label: "Sold", tone: "neutral" },
  released: { label: "Released", tone: "success" },
};

export function CollateralPanel({
  loanId,
  items,
}: {
  loanId: string;
  items: { id: string; description: string; valueCents: number | null; status: string }[];
}) {
  const { run, error, pending } = useRun();
  const [description, setDescription] = useState("");
  const [value, setValue] = useState("");
  const [adding, setAdding] = useState(false);
  const statusItems = Object.entries(COLLATERAL).map(([value, s]) => ({ value, label: s.label }));
  const dollars = value.trim() === "" ? null : Number(value.replace(/[$,\s]/g, ""));
  const validValue = dollars === null || (Number.isFinite(dollars) && dollars > 0);

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Collateral</CardTitle>
        <CardDescription>{items.length ? "Held against this loan." : "None recorded. The game doesn’t track collateral."}</CardDescription>
        {!adding ? (
          <CardAction>
            <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
              Add
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className={!items.length && !adding ? "hidden" : "space-y-4"}>
        {items.length ? (
          <ul className="divide-y rounded-lg border">
            {items.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2 p-3 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="font-medium break-words">{c.description}</div>
                  {c.valueCents ? (
                    <div className="text-xs text-muted-foreground">
                      worth about <Money cents={c.valueCents} />
                    </div>
                  ) : null}
                </div>
                <Select
                  value={c.status}
                  onValueChange={(v) => run(() => setCollateralStatusAction({ collateralId: c.id, status: v as "held" }), "Collateral updated.")}
                  items={statusItems}
                >
                  <SelectTrigger size="sm" aria-label={`Status of ${c.description}`}>
                    <SelectValue>{(v: string) => <StatusBadge tone={COLLATERAL[v]?.tone ?? "neutral"}>{COLLATERAL[v]?.label ?? v}</StatusBadge>}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {statusItems.map((s) => (
                      <SelectItem key={s.value} value={s.value}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </li>
            ))}
          </ul>
        ) : null}
        <form method="post"
          hidden={!adding}
          onSubmit={(e) => {
            e.preventDefault();
            run(
              () => addCollateralAction({ loanId, description, estimatedValueCents: dollars === null ? null : Math.round(dollars * 100) }),
              "Collateral recorded.",
              () => {
                setDescription("");
                setValue("");
                setAdding(false);
              },
            );
          }}
        >
          <FieldGroup className="gap-3">
            <Field>
              <FieldLabel htmlFor="collateral-desc">What is it?</FieldLabel>
              <Input id="collateral-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Bravado Banshee, plate 12ABC345" />
            </Field>
            <Field>
              <FieldLabel htmlFor="collateral-value">Estimated value (optional)</FieldLabel>
              <Input id="collateral-value" value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal" placeholder="$" aria-invalid={!validValue || undefined} />
            </Field>
            {error ? <FieldError>{error}</FieldError> : null}
            <div className="flex gap-2">
              <Button type="submit" variant="outline" disabled={pending || description.trim().length < 2 || !validValue}>
                {pending ? <Spinner /> : null}
                Add collateral
              </Button>
              <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            </div>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}

export function NoteForm({ loanId }: { loanId: string }) {
  const { run, error, pending } = useRun();
  const [text, setText] = useState("");
  return (
    <form method="post"
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => addNoteAction({ loanId, text }), "Note added.", () => setText(""));
      }}
    >
      <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={2000} placeholder="Add a note (contact attempts, agreements…)" aria-label="Note" />
      {text.length > 1800 ? <p className="text-xs text-muted-foreground">{2000 - text.length} characters left</p> : null}
      {error ? <FieldError>{error}</FieldError> : null}
      <Button type="submit" size="sm" variant="outline" disabled={pending || text.trim().length === 0}>
        {pending ? <Spinner /> : null}
        Add note
      </Button>
    </form>
  );
}

/** The game sometimes leaves a paid-off loan in the Default/Overdue tab. Management+. */
export function MarkRepaidPanel({ loanId, owedCents }: { loanId: string; owedCents: number }) {
  const withStepUp = useStepUp();
  const { run, error, pending } = useRun();
  const [reason, setReason] = useState("");
  return (
    <Card className="border-info/40">
      <CardHeader>
        <CardTitle>Repaid, but stuck in the game?</CardTitle>
        <CardDescription>
          The books show this loan repaid ({owedCents > 0 ? <>only <Money cents={owedCents} /> left, within rounding</> : <>nothing left to pay</>}). If the
          game still lists it as overdue or defaulted, mark it as repaid. Later pastes won&rsquo;t move it back.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form method="post"
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              const r = await withStepUp(() => markRepaidAction({ loanId, reason }));
              return r.ok ? { ok: true } : r;
            }, "Marked as repaid.");
          }}
        >
          <Field>
            <FieldLabel htmlFor="repaid-reason">Reason</FieldLabel>
            <Textarea id="repaid-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="e.g. Paid off early on 22 Jun; game bug kept it in Default" />
          </Field>
          {error ? <FieldError>{error}</FieldError> : null}
          <Button type="submit" variant="outline" disabled={pending || reason.trim().length < 5}>
            {pending ? <Spinner /> : null}
            Mark as repaid
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
