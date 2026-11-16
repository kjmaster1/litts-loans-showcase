"use client";

import { Lock } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Money } from "@/components/data/money";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { applyOfficerSuggestionsAction, assignPayoutAction, closeWeekAction, linkWalletAction, saveRosterAction } from "./actions";

type Result = { ok: true } | { ok: false; error: string };

function useRun() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const run = (fn: () => Promise<Result>, success: string) => {
    setError(null);
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) return setError(r.error);
      toast.success(success);
      router.refresh();
    });
  };
  return { run, error, pending };
}

export type RosterItem = {
  staffId: string;
  name: string;
  role: string;
  included: boolean;
  suggested: boolean;
  evidence: { appActions: number; loansArranged: number; loansServiced: number; mortgagesArranged: number; bankRows: number };
};

function evidenceText(e: RosterItem["evidence"]) {
  const parts = [
    e.appActions ? `${e.appActions} action${e.appActions === 1 ? "" : "s"} in the app` : null,
    e.loansArranged ? `${e.loansArranged} loan${e.loansArranged === 1 ? "" : "s"} arranged` : null,
    e.loansServiced ? `${e.loansServiced} loan${e.loansServiced === 1 ? "" : "s"} paid in` : null,
    e.mortgagesArranged ? `${e.mortgagesArranged} mortgage${e.mortgagesArranged === 1 ? "" : "s"} arranged` : null,
    e.bankRows ? `${e.bankRows} bank transaction${e.bankRows === 1 ? "" : "s"}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "No activity recorded";
}

export function RosterForm({ weekKey, roster, locked, ended, perPersonHint }: { weekKey: string; roster: RosterItem[]; locked: boolean; ended: boolean; perPersonHint: string }) {
  const { run, error, pending } = useRun();
  const [included, setIncluded] = useState(() => new Set(roster.filter((r) => r.included).map((r) => r.staffId)));
  const toggle = (id: string) =>
    setIncluded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="space-y-3">
      <ul className="divide-y rounded-lg border">
        {roster.map((r) => (
          <li key={r.staffId} className="flex items-start gap-3 p-3 text-sm">
            <input
              type="checkbox"
              id={`roster-${r.staffId}`}
              className="mt-0.5 size-4 accent-primary"
              checked={included.has(r.staffId)}
              disabled={locked || pending}
              onChange={() => toggle(r.staffId)}
            />
            <label htmlFor={`roster-${r.staffId}`} className="min-w-0 flex-1">
              <span className="font-medium">{r.name}</span>
              {r.suggested ? <span className="ml-2 text-xs text-success">suggested</span> : null}
              <span className="block text-xs text-muted-foreground">{evidenceText(r.evidence)}</span>
            </label>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">{perPersonHint}</p>
      {error ? <FieldError>{error}</FieldError> : null}
      {locked ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Lock className="size-4" aria-hidden /> Roster locked.
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={pending} onClick={() => run(() => saveRosterAction({ weekKey, included: [...included] }), "Roster saved.")}>
            {pending ? <Spinner /> : null}
            Save
          </Button>
          <Button
            disabled={pending || !ended}
            title={ended ? undefined : "Available once the week has ended"}
            onClick={() => run(() => saveRosterAction({ weekKey, included: [...included], lock: true }), "Roster locked.")}
          >
            <Lock aria-hidden /> Lock roster
          </Button>
        </div>
      )}
    </div>
  );
}

export function CloseWeekButton({ weekKey, totalCents, disabledReason, label = "Close week" }: { weekKey: string; totalCents: number; disabledReason: string | null; label?: string }) {
  const { run, error, pending } = useRun();
  return (
    <div className="space-y-2">
      <Button disabled={pending || disabledReason !== null} onClick={() => run(async () => closeWeekAction(weekKey), "Closed and commission booked.")}>
        {pending ? <Spinner /> : null}
        {label} · book <Money cents={totalCents} className="ml-1" />
      </Button>
      {disabledReason ? <p className="text-sm text-muted-foreground">{disabledReason}</p> : null}
      {error ? <FieldError>{error}</FieldError> : null}
    </div>
  );
}

const OLD = "old_scheme";

export function AssignPayout({ txId, staff }: { txId: string; staff: { id: string; name: string }[] }) {
  const { run, error, pending } = useRun();
  const [to, setTo] = useState<string>("");
  const items = [...staff.map((s) => ({ value: s.id, label: s.name })), { value: OLD, label: "Old scheme (before 12 Oct): keep as expense" }];
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={to} onValueChange={(v) => setTo(String(v))} items={items}>
        <SelectTrigger size="sm" className="w-56" aria-label="Who was paid">
          <SelectValue placeholder="Who was paid?" />
        </SelectTrigger>
        <SelectContent>
          {staff.map((s) => (
            <SelectItem key={s.id} value={s.id}>
              {s.name}
            </SelectItem>
          ))}
          <SelectSeparator />
          <SelectItem value={OLD}>Old scheme (before 12 Oct): keep as expense</SelectItem>
        </SelectContent>
      </Select>
      <Button size="sm" variant="outline" disabled={pending || !to} onClick={() => run(() => assignPayoutAction({ bankTransactionId: txId, to: to as never }), "Payout assigned.")}>
        {pending ? <Spinner /> : null}
        Assign
      </Button>
      {error ? <FieldError className="w-full">{error}</FieldError> : null}
    </div>
  );
}

export type WalletItem = { wallet: string; staffName: string | null; payouts: number; borrowers: number; lastPaid: string };

/** Who each wallet paid by the old commission runs belongs to. */
export function WalletLinks({ wallets, staff }: { wallets: WalletItem[]; staff: { id: string; name: string }[] }) {
  return (
    <ul className="divide-y rounded-lg border">
      {wallets.map((w) => (
        <li key={w.wallet} className="space-y-2 p-3 text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <span className="ident font-medium">Wallet {w.wallet}</span>
            <span className="text-xs text-muted-foreground">
              {w.payouts} payment{w.payouts === 1 ? "" : "s"} · {w.borrowers} borrower{w.borrowers === 1 ? "" : "s"} · last {w.lastPaid}
            </span>
          </div>
          {w.staffName ? <p>{w.staffName}</p> : <LinkWallet wallet={w.wallet} staff={staff} />}
        </li>
      ))}
    </ul>
  );
}

function LinkWallet({ wallet, staff }: { wallet: string; staff: { id: string; name: string }[] }) {
  const { run, error, pending } = useRun();
  const [to, setTo] = useState<string>("");
  const items = staff.map((s) => ({ value: s.id, label: s.name }));
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={to} onValueChange={(v) => setTo(String(v))} items={items}>
        <SelectTrigger size="sm" className="w-48" aria-label={`Whose is wallet ${wallet}`}>
          <SelectValue placeholder="Whose wallet?" />
        </SelectTrigger>
        <SelectContent>
          {staff.map((s) => (
            <SelectItem key={s.id} value={s.id}>
              {s.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button size="sm" variant="outline" disabled={pending || !to} onClick={() => run(() => linkWalletAction({ wallet, staffId: to }), "Wallet linked.")}>
        {pending ? <Spinner /> : null}
        Link
      </Button>
      {error ? <FieldError className="w-full">{error}</FieldError> : null}
    </div>
  );
}

export type SuggestionItem = { loanId: string; borrower: string; status: string; staffName: string; basis: "loan" | "borrower"; inCatchUp: boolean };

/** Officers suggested from the old commission payments; the user ticks which to assign. */
export function SuggestedOfficers({ suggestions, waiting }: { suggestions: SuggestionItem[]; waiting: number }) {
  const { run, error, pending } = useRun();
  const [chosen, setChosen] = useState(() => new Set(suggestions.map((s) => s.loanId)));
  const toggle = (id: string) =>
    setChosen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="space-y-3">
      {suggestions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No suggestions{waiting ? " yet" : ""}.</p>
      ) : (
        <ul className="max-h-96 divide-y overflow-y-auto rounded-lg border">
          {suggestions.map((s) => (
            <li key={s.loanId} className="flex items-start gap-3 p-3 text-sm">
              <input
                type="checkbox"
                id={`officer-${s.loanId}`}
                className="mt-0.5 size-4 accent-primary"
                checked={chosen.has(s.loanId)}
                disabled={pending}
                onChange={() => toggle(s.loanId)}
              />
              <label htmlFor={`officer-${s.loanId}`} className="min-w-0 flex-1">
                <span className="font-medium">{s.borrower}</span> → {s.staffName}
                {s.inCatchUp ? <span className="ml-2 text-xs text-warning">needed for the catch-up</span> : null}
                <span className="block text-xs text-muted-foreground">
                  {s.basis === "loan" ? "Paid commission on this loan" : "Paid commission on an earlier loan of theirs"} · {s.status}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {waiting ? (
        <p className="text-xs text-muted-foreground">
          {waiting} more loan{waiting === 1 ? "" : "s"} will be suggested once {waiting === 1 ? "its" : "their"} wallet is linked to a person.
        </p>
      ) : null}
      {error ? <FieldError>{error}</FieldError> : null}
      {suggestions.length ? (
        <Button disabled={pending || chosen.size === 0} onClick={() => run(() => applyOfficerSuggestionsAction({ loanIds: [...chosen] }), "Officers assigned.")}>
          {pending ? <Spinner /> : null}
          Assign {chosen.size} officer{chosen.size === 1 ? "" : "s"}
        </Button>
      ) : null}
    </div>
  );
}
