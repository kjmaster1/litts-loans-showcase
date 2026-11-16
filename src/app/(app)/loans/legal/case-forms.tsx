"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { formatCents } from "@/lib/format";
import { closeCaseAction, confirmFeePaymentAction, handToLegalAction, markContractSharedAction, requestDetailsAction, setCaseDefaultDateAction, setContractNoteAction, setLegalTermsAction, unlinkFeePaymentAction } from "./actions";

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

const dollarsOf = (text: string): number | null => {
  const t = text.replace(/[$,\s]/g, "");
  if (!t) return null;
  const n = Number(t);
  return Number.isInteger(n) && n > 0 ? n : NaN;
};

/** The two things only the signed contract says: the Defaulted Account Fee per day and the collateral. */
export function ContractDetailsForm({
  loanId,
  feePerDayCents,
  unsecured,
  collateral,
}: {
  loanId: string;
  feePerDayCents: number | null;
  unsecured: boolean;
  /** What's recorded already (on the loan or its offer); more can be added. */
  collateral: string | null;
}) {
  const { run, error, pending } = useRun();
  const [fee, setFee] = useState(feePerDayCents ? String(feePerDayCents / 100) : "");
  const [item, setItem] = useState("");
  const [none, setNone] = useState(unsecured);
  const dollars = dollarsOf(fee);
  const validFee = dollars === null || Number.isFinite(dollars);

  return (
    <form
      method="post"
      onSubmit={(e) => {
        e.preventDefault();
        // One save: the fee per day, Unsecured and any collateral typed go in together, or not at all.
        run(
          () =>
            setLegalTermsAction({
              loanId,
              feePerDayDollars: dollars === null || Number.isNaN(dollars) ? null : dollars,
              unsecured: none,
              collateral: !none && item.trim() ? item.trim() : undefined,
            }),
          "Contract details saved.",
          () => setItem(""),
        );
      }}
    >
      <FieldGroup className="gap-4">
        <Field>
          <FieldLabel htmlFor="fee-per-day">Defaulted Account Fee per day</FieldLabel>
          <Input id="fee-per-day" inputMode="numeric" placeholder="$" value={fee} onChange={(e) => setFee(e.target.value)} aria-invalid={!validFee || undefined} className="max-w-40" />
          <FieldDescription>As written in the signed contract (Defaulted Account Fee).</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="collateral-item">{collateral && !unsecured ? "Add more collateral" : "Collateral"}</FieldLabel>
          {collateral && !unsecured ? <p className="text-sm">Recorded: {collateral}</p> : null}
          <Input id="collateral-item" value={item} disabled={none} onChange={(e) => setItem(e.target.value)} placeholder="e.g. Ocelot Jackal - G1YBEU4B" />
          <FieldDescription>Vehicle and plate, or the property, as the lawyer should see it.</FieldDescription>
        </Field>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5 size-4 accent-primary" checked={none} onChange={(e) => setNone(e.target.checked)} />
          <span>Unsecured: no collateral was pledged</span>
        </label>
        {error ? <FieldError>{error}</FieldError> : null}
        <div>
          <Button type="submit" disabled={pending || !validFee}>
            {pending ? <Spinner /> : null}
            Save contract details
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}

export function ContractSharedToggle({ loanId, shared, canEdit }: { loanId: string; shared: boolean; canEdit: boolean }) {
  const { run, error, pending } = useRun();
  return (
    <div className="space-y-1">
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5 size-4 accent-primary"
          checked={shared}
          disabled={!canEdit || pending}
          onChange={(e) => run(() => markContractSharedAction({ loanId, shared: e.target.checked }), e.target.checked ? "Marked as shared." : "Unmarked.")}
        />
        <span>The signed contract has been shared with the lawyer in game</span>
      </label>
      {error ? <FieldError>{error}</FieldError> : null}
    </div>
  );
}

export function AskOfficerButton({ loanId, officerName, asked }: { loanId: string; officerName: string; asked: boolean }) {
  const { run, error, pending } = useRun();
  return (
    <div className="space-y-1">
      <Button variant="outline" size="sm" disabled={pending} onClick={() => run(() => requestDetailsAction(loanId), `${officerName} has been asked.`)}>
        {pending ? <Spinner /> : null}
        {asked ? `Ask ${officerName} again` : `Ask ${officerName}`}
      </Button>
      {error ? <FieldError>{error}</FieldError> : null}
    </div>
  );
}

export function DefaultDateForm({ loanId, current, overridden }: { loanId: string; current: string | null; overridden: boolean }) {
  const { run, error, pending } = useRun();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(current ?? "");
  const [reason, setReason] = useState("");
  if (!open)
    return (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Correct the default date
      </Button>
    );
  return (
    <form
      method="post"
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => setCaseDefaultDateAction({ loanId, date: date || null, reason }), "Default date updated.", () => setOpen(false));
      }}
    >
      <Field>
        <FieldLabel htmlFor="case-default-date">Defaulted on</FieldLabel>
        <Input id="case-default-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} className="max-w-48" />
        <FieldDescription>Leave empty to go back to the date from the phone cards.</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="case-default-reason">Why</FieldLabel>
        <Input id="case-default-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Moved to Default by hand on 6 Oct" />
      </Field>
      {error ? <FieldError>{error}</FieldError> : null}
      <div className="flex gap-2">
        <Button type="submit" variant="outline" disabled={pending || reason.trim().length < 3 || (!date && !overridden)}>
          {pending ? <Spinner /> : null}
          Save date
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Management: a note for Legal that the signed contract states a different weekly payment (owner, 2026-11-10). */
export function ContractNoteForm({ loanId, currentCents }: { loanId: string; currentCents: number | null }) {
  const { run, error, pending } = useRun();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(currentCents ? String(currentCents / 100) : "");
  const [reason, setReason] = useState("");
  if (!open)
    return (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        {currentCents ? "Change the contract note" : "The contract says a different payment"}
      </Button>
    );
  const save = (dollars: number | null, message: string) => run(() => setContractNoteAction({ loanId, dollars, reason }), message, () => setOpen(false));
  return (
    <form
      method="post"
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        const dollars = dollarsOf(amount);
        if (dollars === null || Number.isNaN(dollars)) {
          const field = e.currentTarget.querySelector<HTMLInputElement>("#case-contract-payment");
          field?.setCustomValidity("Type the weekly payment in whole dollars, e.g. 5161.");
          field?.reportValidity();
          return;
        }
        save(dollars, "Contract note saved.");
      }}
    >
      <Field>
        <FieldLabel htmlFor="case-contract-payment">Weekly payment on the contract</FieldLabel>
        <Input
          id="case-contract-payment"
          inputMode="numeric"
          value={amount}
          onChange={(e) => {
            e.currentTarget.setCustomValidity("");
            setAmount(e.target.value);
          }}
          placeholder="$5,161"
          className="max-w-48"
          required
        />
        <FieldDescription>The sheet still claims the phone card’s amount. Legal sees this note.</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="case-contract-reason">Why it differs</FieldLabel>
        <Input id="case-contract-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Contract written at 22%, game set at 21%" required minLength={3} />
      </Field>
      {error ? <FieldError>{error}</FieldError> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? <Spinner /> : null}
          Save note
        </Button>
        {currentCents ? (
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={(e) => {
              if (e.currentTarget.form?.querySelector<HTMLInputElement>("#case-contract-reason")?.reportValidity() === false) return;
              save(null, "Contract note removed.");
            }}
          >
            Remove the note
          </Button>
        ) : null}
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function HandToLegalButton({
  loanId,
  legalStaff,
  again,
  totalCents,
}: {
  loanId: string;
  legalStaff: { id: string; name: string }[];
  again: boolean;
  /** The total shown on this page; the server refuses the hand-over if it has changed since. */
  totalCents: number;
}) {
  const { run, error, pending } = useRun();
  const [open, setOpen] = useState(false);
  const [payee, setPayee] = useState(legalStaff[0]?.id ?? "");
  const [reason, setReason] = useState("");
  const items = legalStaff.map((s) => ({ value: s.id, label: s.name }));
  return (
    <>
      <Button variant={again ? "outline" : "default"} onClick={() => setOpen(true)}>
        {again ? "Hand over again" : "Hand to Legal"}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{again ? "Hand this case over again?" : "Hand this case to Legal?"}</DialogTitle>
            <DialogDescription>
              The days in default are counted to today and the sheet is fixed at {formatCents(totalCents)}. The attorney &amp; filing fee is then due to the lawyer.
            </DialogDescription>
          </DialogHeader>
          <form
            method="post"
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              run(() => handToLegalAction({ loanId, payeeStaffId: payee, reason: again ? reason : undefined, expectedTotalCents: totalCents }), "Handed to Legal.", () => setOpen(false));
            }}
          >
            {legalStaff.length === 0 ? (
              <p className="text-sm text-danger">Nobody has a Legal Team login yet. Invite the lawyer on the Staff page first.</p>
            ) : legalStaff.length > 1 ? (
              <Field>
                <FieldLabel htmlFor="payee">Lawyer</FieldLabel>
                <Select value={payee} onValueChange={(v) => setPayee(v as string)} items={items}>
                  <SelectTrigger id="payee">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {items.map((s) => (
                      <SelectItem key={s.value} value={s.value}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            ) : (
              <p className="text-sm">Lawyer: {legalStaff[0].name}</p>
            )}
            {again ? (
              <Field>
                <FieldLabel htmlFor="handover-reason">Why it’s handed over again</FieldLabel>
                <Textarea id="handover-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. The fee per day was wrong" />
                <FieldDescription>The earlier sheet stays on record.</FieldDescription>
              </Field>
            ) : null}
            {error ? <FieldError>{error}</FieldError> : null}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Not yet
              </Button>
              <Button type="submit" disabled={pending || !payee || (again && reason.trim().length < 3)}>
                {pending ? <Spinner /> : null}
                {again ? "Hand over again" : "Hand to Legal"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function ConfirmFeeButton({ loanId, txId }: { loanId: string; txId: string }) {
  const { run, error, pending } = useRun();
  return (
    <span className="inline-flex flex-col gap-1">
      <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => confirmFeePaymentAction({ loanId, txId }), "Fee payment linked.")}>
        {pending ? <Spinner /> : null}
        This is the fee
      </Button>
      {error ? <FieldError>{error}</FieldError> : null}
    </span>
  );
}

export function CloseCaseButton({ loanId }: { loanId: string }) {
  const { run, error, pending } = useRun();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Close case
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Close this case?</DialogTitle>
            <DialogDescription>It leaves the open list. Money that comes in later still shows on it.</DialogDescription>
          </DialogHeader>
          <form
            method="post"
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              run(() => closeCaseAction({ loanId, note }), "Case closed.", () => setOpen(false));
            }}
          >
            <Field>
              <FieldLabel htmlFor="close-note">Note</FieldLabel>
              <Textarea id="close-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Collateral sold, the rest unrecoverable" />
            </Field>
            {error ? <FieldError>{error}</FieldError> : null}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Keep open
              </Button>
              <Button type="submit" disabled={pending || note.trim().length < 3}>
                {pending ? <Spinner /> : null}
                Close case
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Management: a payment linked to this case by mistake (a mistyped reference, a wrong confirmation). */
export function UnlinkFeeButton({ loanId, txId }: { loanId: string; txId: string }) {
  const { run, error, pending } = useRun();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Not this case’s fee
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Unlink this payment?</DialogTitle>
            <DialogDescription>The case shows the fee as unpaid again. The payment can then be linked to the right case.</DialogDescription>
          </DialogHeader>
          <form
            method="post"
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              run(() => unlinkFeePaymentAction({ loanId, txId, reason }), "Payment unlinked.", () => setOpen(false));
            }}
          >
            <Field>
              <FieldLabel htmlFor={`unlink-${txId}`}>Why</FieldLabel>
              <Textarea id={`unlink-${txId}`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Paid for another case; the reference was mistyped" />
            </Field>
            {error ? <FieldError>{error}</FieldError> : null}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Keep it
              </Button>
              <Button type="submit" disabled={pending || reason.trim().length < 3}>
                {pending ? <Spinner /> : null}
                Unlink
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
