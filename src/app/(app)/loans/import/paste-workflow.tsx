"use client";

import { formatCents } from "@/lib/format";
import { ArrowRight, CircleCheck, ClipboardPaste } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { LoanStatusBadge } from "@/components/data/loan-status-badge";
import { LocalTime } from "@/components/data/local-time";
import { Money } from "@/components/data/money";
import { StatusBadge } from "@/components/data/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { CardPreview, LoanSummary, PastePreview } from "@/server/loans/paste";
import { commitPasteAction, previewPasteAction } from "../actions";

type Tab = PastePreview["tab"];
type Decision = { loan?: string; officerStaffId?: string | null };

const TABS: { key: Tab; label: string }[] = [
  { key: "active", label: "Active" },
  { key: "overdue", label: "Overdue" },
  { key: "default", label: "Default" },
  { key: "complete", label: "Complete" },
];
const IGNORED: Record<string, string> = {
  legacy_mortgage: "Legacy mortgage, not tracked here",
  not_business_wallet: "Not paid to the business wallet",
  duplicate_card: "Same card twice in this paste, counted once",
};
const HOW: Record<string, string> = {
  principal: "by amount",
  agreement_total: "by total repayable",
  instalments: "by instalments",
  only_loan: "borrower's only loan",
};
const NONE = "__none";

function LoanLine({ loan }: { loan: LoanSummary }) {
  return (
    <span>
      <Money cents={loan.principalCents} /> · opened <LocalTime value={loan.openedAt} format="date" /> · {loan.returnedPct}% repaid
    </span>
  );
}

export function PasteWorkflow({ lastPasted }: { lastPasted: Record<string, string | null> }) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("active");
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<PastePreview | null>(null);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Tab[]>([]);
  const [pending, startTransition] = useTransition();

  const decide = (index: number, patch: Decision) => setDecisions((d) => ({ ...d, [index]: { ...d[index], ...patch } }));
  const unresolved = useMemo(
    () =>
      (preview?.cards ?? []).filter((c) => (c.match.kind === "ambiguous" || (c.match.kind === "new" && !c.match.refused)) && !decisions[c.index]?.loan).length,
    [preview, decisions],
  );

  function runPreview() {
    setError(null);
    startTransition(async () => {
      const result = await previewPasteAction({ tab, text });
      if (!result.ok) return setError(result.error);
      setPreview(result.data);
      setDecisions({});
    });
  }

  function commit() {
    if (!preview) return;
    setError(null);
    startTransition(async () => {
      const result = await commitPasteAction({ tab: preview.tab, text, decisions });
      if (!result.ok) return setError(result.error);
      const r = result.data;
      toast.success(
        `${TABS.find((t) => t.key === preview.tab)?.label} tab saved: ${r.updated} loans updated${r.statusChanges ? `, ${r.statusChanges} status changes` : ""}${r.created ? `, ${r.created} new` : ""}.`,
      );
      const finished = [...new Set([...done, preview.tab])];
      setDone(finished);
      setPreview(null);
      setText("");
      setDecisions({});
      const next = TABS.find((t) => !finished.includes(t.key));
      if (next) setTab(next.key);
      router.refresh();
    });
  }

  if (preview) {
    return (
      <PreviewView
        preview={preview}
        decisions={decisions}
        decide={decide}
        setAllOfficers={(id) =>
          setDecisions((d) => {
            const next = { ...d };
            for (const c of preview.cards) {
              const loan = c.match.kind === "matched" ? c.match.loan : null;
              if (c.match.kind === "ignored" || (loan && loan.officerStaffId)) continue;
              next[c.index] = { ...next[c.index], officerStaffId: id };
            }
            return next;
          })
        }
        unresolved={unresolved}
        pending={pending}
        error={error}
        onBack={() => {
          setPreview(null);
          setError(null);
        }}
        onCommit={commit}
      />
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <Card>
        <CardHeader>
          <CardTitle>Paste a tab</CardTitle>
          <CardDescription>Nothing is saved until you&rsquo;ve checked the preview.</CardDescription>
        </CardHeader>
        <CardContent>
          <form method="post"
            onSubmit={(e) => {
              e.preventDefault();
              runPreview();
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel id="tab-label">Which tab?</FieldLabel>
                <div role="radiogroup" aria-labelledby="tab-label" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {TABS.map((t) => (
                    <button
                      key={t.key}
                      type="button"
                      role="radio"
                      aria-checked={tab === t.key}
                      onClick={() => setTab(t.key)}
                      className={cn(
                        "flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                        tab === t.key ? "border-primary bg-primary/5 text-foreground" : "text-muted-foreground hover:bg-muted",
                      )}
                    >
                      {done.includes(t.key) ? <CircleCheck className="size-4 text-success" aria-label="done" /> : null}
                      {t.label}
                    </button>
                  ))}
                </div>
              </Field>
              <Field>
                <FieldLabel htmlFor="paste">Tab contents</FieldLabel>
                <Textarea
                  id="paste"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={14}
                  className="font-mono text-xs"
                  placeholder={"Paste the whole tab here.\n\nIt starts with the first card’s amount (e.g. $9,874.00) and ends with the last card."}
                  spellCheck={false}
                />
                <FieldDescription>Select everything in the tab on the phone, copy, and paste it here as-is.</FieldDescription>
              </Field>
              {error ? <FieldError>{error}</FieldError> : null}
              <div>
                <Button type="submit" disabled={pending || text.trim().length === 0}>
                  {pending ? <Spinner /> : <ClipboardPaste aria-hidden />}
                  Preview
                </Button>
              </div>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>

      <Card className="h-fit">
        <CardHeader>
          <CardTitle className="text-base">Last pasted</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="space-y-2 text-sm">
            {TABS.map((t) => (
              <div key={t.key} className="flex justify-between gap-2">
                <dt className="text-muted-foreground">{t.label}</dt>
                <dd>{lastPasted[t.key] ? <LocalTime value={lastPasted[t.key]} format="relative" /> : <span className="text-warning">Never</span>}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}

function PreviewView({
  preview,
  decisions,
  decide,
  setAllOfficers,
  unresolved,
  pending,
  error,
  onBack,
  onCommit,
}: {
  preview: PastePreview;
  decisions: Record<string, Decision>;
  decide: (index: number, patch: Decision) => void;
  setAllOfficers: (id: string | null) => void;
  unresolved: number;
  pending: boolean;
  error: string | null;
  onBack: () => void;
  onCommit: () => void;
}) {
  const label = TABS.find((t) => t.key === preview.tab)?.label;
  const { counts } = preview;
  const officerItems = [{ value: NONE, label: "Unassigned" }, ...preview.officers.map((o) => ({ value: o.id, label: o.name }))];
  const soloOfficer = preview.officers.length === 1;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <StatusBadge tone="info">{label} tab</StatusBadge>
        <span>
          <span className="num font-medium">{preview.cards.length}</span> cards: <span className="num">{counts.matched}</span> matched
          {counts.ambiguous ? (
            <>
              , <span className="num text-warning">{counts.ambiguous}</span> need a choice
            </>
          ) : null}
          {counts.new ? (
            <>
              , <span className="num">{counts.new}</span> new
            </>
          ) : null}
          {counts.ignored ? (
            <>
              , <span className="num">{counts.ignored}</span> ignored
            </>
          ) : null}
        </span>
      </div>

      {preview.repeatOf ? (
        <Alert variant="warning">
          <AlertTitle>
            Same text as the {label} tab pasted <LocalTime value={preview.repeatOf} />
          </AlertTitle>
          <AlertDescription>
            The phone&rsquo;s countdowns (&ldquo;Next payment: in 23 hours&rdquo;) would have changed since then, so this is probably an old copy,
            or the phone hadn&rsquo;t refreshed. Open the tab on the phone and copy it again. If you save this anyway, next payment times
            still come from the bank.
          </AlertDescription>
        </Alert>
      ) : null}

      {preview.missing.length > 0 ? (
        <Alert variant="warning">
          <AlertTitle>
            {preview.missing.length} loan{preview.missing.length === 1 ? " was" : "s were"} in this tab last time but not now
          </AlertTitle>
          <AlertDescription>
            <p>They have probably moved to another tab. Paste all four tabs to update them.</p>
            <ul className="mt-1 list-disc pl-5">
              {preview.missing.slice(0, 8).map((l) => (
                <li key={l.id}>
                  {l.borrowerName ?? "Unknown"} <span className="ident">#{l.borrowerStateId}</span> · <Money cents={l.principalCents} />
                </li>
              ))}
              {preview.missing.length > 8 ? <li>and {preview.missing.length - 8} more</li> : null}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      {preview.officers.length > 0 ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <span className="text-sm text-muted-foreground">
            {soloOfficer ? "Claim every unassigned loan below as yours:" : "Set the officer for every unassigned loan below:"}
          </span>
          <Select
            defaultValue={NONE}
            onValueChange={(v) => setAllOfficers(v === NONE ? null : String(v))}
            items={officerItems}
          >
            <SelectTrigger className="sm:w-56" aria-label="Officer for all unassigned loans">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {officerItems.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      <div className="overflow-hidden rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">#</TableHead>
              <TableHead>Card</TableHead>
              <TableHead>Loan</TableHead>
              <TableHead className="hidden md:table-cell">Status</TableHead>
              <TableHead className="w-56">Officer</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {preview.cards.map((c) => (
              <CardRow key={c.index} card={c} decision={decisions[c.index] ?? {}} decide={decide} officerItems={officerItems} />
            ))}
          </TableBody>
        </Table>
      </div>

      {preview.ignoredLines.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Ignored {preview.ignoredLines.length} line{preview.ignoredLines.length === 1 ? "" : "s"} before the first card.
        </p>
      ) : null}

      {error ? <FieldError>{error}</FieldError> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={onCommit} disabled={pending || unresolved > 0}>
          {pending ? <Spinner /> : null}
          Save {label} tab <ArrowRight aria-hidden />
        </Button>
        <Button variant="outline" onClick={onBack} disabled={pending}>
          Back
        </Button>
        {unresolved > 0 ? (
          <span className="text-sm text-warning">
            Choose what to do with {unresolved} card{unresolved === 1 ? "" : "s"} first.
          </span>
        ) : null}
        <Link href="/loans" className="ml-auto text-sm text-muted-foreground underline-offset-4 hover:underline">
          Cancel
        </Link>
      </div>
    </div>
  );
}

function CardRow({
  card: c,
  decision,
  decide,
  officerItems,
}: {
  card: CardPreview;
  decision: Decision;
  decide: (index: number, patch: Decision) => void;
  officerItems: { value: string; label: string }[];
}) {
  const matched = c.match.kind === "matched" ? c.match.loan : null;
  const chosen = c.match.kind === "ambiguous" ? c.match.candidates.find((l) => l.id === decision.loan) : null;
  const loan = matched ?? chosen ?? null;
  const name = loan?.borrowerName ?? (c.match.kind === "ambiguous" ? c.match.candidates[0]?.borrowerName : null);
  const ignored = c.match.kind === "ignored";
  const skipped = decision.loan === "skip" || (c.match.kind === "new" && c.match.refused !== null);

  return (
    <TableRow className={cn(ignored && "text-muted-foreground")}>
      <TableCell className="num align-top">{c.index + 1}</TableCell>
      <TableCell className="align-top whitespace-normal">
        <div className="font-medium">
          {name ?? "Unknown borrower"} <span className="ident text-xs font-normal text-muted-foreground">#{c.stateId}</span>
        </div>
        <div className="text-xs text-muted-foreground">
          <Money cents={c.headerAmountCents} /> per payment
          {c.progress ? <> · {c.progress}</> : null}
          {c.missed ? <span className="text-warning"> · {c.missed} missed</span> : null}
        </div>
        {c.warnings.length ? <div className="text-xs text-warning">{c.warnings.join(" ")}</div> : null}
      </TableCell>
      <TableCell className="align-top text-sm whitespace-normal">
        {c.match.kind === "matched" ? (
          <>
            <LoanLine loan={c.match.loan} />
            <div className="text-xs text-muted-foreground">Matched {HOW[c.match.how] ?? c.match.how}</div>
          </>
        ) : c.match.kind === "ambiguous" ? (
          <Select
            value={decision.loan ?? ""}
            onValueChange={(v) => decide(c.index, { loan: String(v) })}
            items={[
              ...c.match.candidates.map((l) => ({ value: l.id, label: `${formatCents(l.principalCents)} · ${l.returnedPct}% repaid` })),
              { value: "skip", label: "Skip this card" },
            ]}
          >
            <SelectTrigger className="w-full" aria-label={`Loan for card ${c.index + 1}`} aria-invalid={!decision.loan || undefined}>
              <SelectValue placeholder="Which loan is this?" />
            </SelectTrigger>
            <SelectContent>
              {c.match.candidates.map((l) => (
                <SelectItem key={l.id} value={l.id}>
                  <LoanLine loan={l} />
                </SelectItem>
              ))}
              <SelectSeparator />
              <SelectItem value="skip">Skip this card</SelectItem>
            </SelectContent>
          </Select>
        ) : c.match.kind === "new" ? (
          <div className="space-y-1.5">
            <div>No matching loan in the bank data.</div>
            {c.match.refused ? (
              <div className="text-danger">{c.match.refused}</div>
            ) : (
              <Select
                value={decision.loan ?? ""}
                onValueChange={(v) => decide(c.index, { loan: String(v) })}
                items={[
                  { value: "new", label: `Add as a new loan of ${formatCents(c.match.principalCents ?? 0)}` },
                  { value: "skip", label: "Skip this card" },
                ]}
              >
                <SelectTrigger className="w-full" aria-label={`What to do with card ${c.index + 1}`} aria-invalid={!decision.loan || undefined}>
                  <SelectValue placeholder="Add it, or skip?" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="new">Add as a new loan of {formatCents(c.match.principalCents ?? 0)}</SelectItem>
                  <SelectItem value="skip">Skip this card</SelectItem>
                </SelectContent>
              </Select>
            )}
            {c.match.borrowerLoans.length ? (
              <div className="text-xs text-muted-foreground">
                Already has: {c.match.borrowerLoans.map((l) => `${formatCents(l.principalCents)} (${l.status.replace("_", " ")})`).join(", ")}. Check this isn&rsquo;t one of them.
              </div>
            ) : null}
          </div>
        ) : (
          IGNORED[c.match.reason] ?? "Ignored"
        )}
      </TableCell>
      <TableCell className="hidden align-top md:table-cell">
        {c.statusTo ? (
          <div className="flex flex-wrap items-center gap-1">
            {loan && loan.status !== c.statusTo ? (
              <>
                <LoanStatusBadge status={loan.status} />
                <ArrowRight className="size-3 text-muted-foreground" aria-label="becomes" />
              </>
            ) : null}
            <LoanStatusBadge status={c.statusTo} />
          </div>
        ) : null}
      </TableCell>
      <TableCell className="align-top">
        {ignored || skipped ? null : loan?.officerName ? (
          <span className="text-sm">{loan.officerName}</span>
        ) : officerItems.length > 1 ? (
          <Select
            value={decision.officerStaffId ?? NONE}
            onValueChange={(v) => decide(c.index, { officerStaffId: v === NONE ? null : String(v) })}
            items={officerItems}
          >
            <SelectTrigger className="w-full" aria-label={`Officer for card ${c.index + 1}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {officerItems.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </TableCell>
    </TableRow>
  );
}
