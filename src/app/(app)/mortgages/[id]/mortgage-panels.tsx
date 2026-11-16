"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { startNavigationProgress } from "@/components/app-shell/navigation-progress";
import { useStepUp } from "@/components/step-up/step-up-provider";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { addMortgageNoteAction, approveMortgageAction, assignMortgageOfficerAction, mergeMortgageAction } from "../actions";

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

const NONE = "__none";

export function MortgageOfficerPanel({
  mortgageId,
  officer,
  tabletOfficer,
  staff,
  viewer,
}: {
  mortgageId: string;
  officer: { id: string; name: string } | null;
  tabletOfficer: string | null;
  staff: { id: string; name: string }[] | null;
  viewer: { id: string };
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
        <CardTitle>Mortgage officer</CardTitle>
        <CardDescription className={officer ? "text-sm font-medium text-foreground" : undefined}>
          {officer ? officer.name : "Nobody is looking after this mortgage yet."}
          {tabletOfficer && tabletOfficer !== officer?.name ? <span className="font-normal text-muted-foreground"> · tablet says {tabletOfficer}</span> : null}
        </CardDescription>
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
                () => assignMortgageOfficerAction({ mortgageId, officerStaffId: choice === NONE ? null : choice, reason: reason.trim() || undefined }),
                "Officer updated.",
                () => setReason(""),
              );
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="m-officer">Officer</FieldLabel>
                <Select value={choice} onValueChange={(v) => setChoice(String(v))} items={items}>
                  <SelectTrigger id="m-officer" className="w-full">
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
                  <FieldLabel htmlFor="m-officer-reason">Reason for the change</FieldLabel>
                  <Input id="m-officer-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Officer left the company" />
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
            <Button variant="outline" disabled={pending} onClick={() => run(() => assignMortgageOfficerAction({ mortgageId, officerStaffId: viewer.id }), "This mortgage is now yours.")}>
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

type MergeTarget = { id: string; address: string; buyerName: string | null; buyerStateId: number | null; originatedAt: string | null; sameBuyer: boolean };

/** Management+: retire this record into the real one (step-up + reason; ADR 0002). */
export function MergeMortgagePanel({ mortgageId, address, hasBankMoney, targets }: { mortgageId: string; address: string; hasBankMoney: boolean; targets: MergeTarget[] }) {
  const router = useRouter();
  const withStepUp = useStepUp();
  const [open, setOpen] = useState(false);
  const [into, setInto] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const label = (t: MergeTarget) => `${t.address} · ${t.buyerName ?? "Unknown buyer"}${t.buyerStateId ? ` #${t.buyerStateId}` : ""}${t.sameBuyer ? " · same buyer" : ""}`;
  const items = targets.map((t) => ({ value: t.id, label: label(t) }));
  const chosen = targets.find((t) => t.id === into);

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Duplicate record?</CardTitle>
        <CardDescription>
          {hasBankMoney
            ? "This record has bank money linked, so it’s the real one. If another record duplicates it, merge that one into this from its own page."
            : "If this is a second copy of another mortgage, merge it into that one. It disappears from every list; its history is kept."}
        </CardDescription>
        {!hasBankMoney && !open ? (
          <CardAction>
            <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
              Merge…
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      {!hasBankMoney && open ? (
        <CardContent>
          <form
            method="post"
            onSubmit={(e) => {
              e.preventDefault();
              if (!into) return;
              setError(null);
              startTransition(async () => {
                const r = await withStepUp(() => mergeMortgageAction({ mortgageId, intoId: into, reason }));
                if (!r.ok) return setError(r.error);
                toast.success(`Merged into ${chosen?.address ?? "the other mortgage"}.`);
                startNavigationProgress();
                router.push(`/mortgages/${into}`);
              });
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="merge-into">Merge “{address}” into</FieldLabel>
                <Select value={into ?? ""} onValueChange={(v) => setInto(v ? String(v) : null)} items={items}>
                  <SelectTrigger id="merge-into" className="w-full">
                    <SelectValue placeholder="Choose the real mortgage" />
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
              <Field>
                <FieldLabel htmlFor="merge-reason">Reason</FieldLabel>
                <Textarea id="merge-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="e.g. Pasted from the tablet heading by mistake; same sale" />
                <FieldDescription>Recorded in the audit log. You&rsquo;ll be asked for an authenticator code.</FieldDescription>
              </Field>
              {error ? <FieldError>{error}</FieldError> : null}
              <div className="flex gap-2">
                <Button type="submit" variant="destructive" disabled={pending || !into || reason.trim().length < 5}>
                  {pending ? <Spinner /> : null}
                  Merge
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

export function MortgageNoteForm({ mortgageId }: { mortgageId: string }) {
  const { run, error, pending } = useRun();
  const [text, setText] = useState("");
  return (
    <form method="post"
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => addMortgageNoteAction({ mortgageId, text }), "Note added.", () => setText(""));
      }}
    >
      <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="Add a note" aria-label="Note" />
      {error ? <FieldError>{error}</FieldError> : null}
      <Button type="submit" size="sm" variant="outline" disabled={pending || !text.trim()}>
        {pending ? <Spinner /> : null}
        Add note
      </Button>
    </form>
  );
}

/** Over the executive-approval line (research/18): how it was approved, or an executive approves it after the fact. */
export function MortgageApprovalPanel({ mortgageId, approved, summary, canApprove }: { mortgageId: string; approved: boolean; summary: React.ReactNode; canApprove: boolean }) {
  const { run, error, pending } = useRun();
  const [reason, setReason] = useState("");
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Executive approval</CardTitle>
        <CardDescription>
          {summary}
          {!approved && !canApprove ? " Ask an executive (Owner, CEO or COO) to look at it." : ""}
        </CardDescription>
      </CardHeader>
      {!approved && canApprove ? (
        <CardContent>
          <form
            method="post"
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              run(() => approveMortgageAction({ mortgageId, reason }), "Mortgage approved.", () => setReason(""));
            }}
          >
            <Field>
              <FieldLabel htmlFor="approve-reason">Why it&rsquo;s approved</FieldLabel>
              <Textarea id="approve-reason" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Buyer vetted; approved by phone before signing" />
              <FieldDescription>Clears the flag. Kept in the mortgage&rsquo;s history and the audit log.</FieldDescription>
              {error ? <FieldError>{error}</FieldError> : null}
            </Field>
            <Button type="submit" size="sm" disabled={pending || reason.trim().length < 5}>
              {pending ? <Spinner /> : null}
              Approve after the fact
            </Button>
          </form>
        </CardContent>
      ) : null}
    </Card>
  );
}
