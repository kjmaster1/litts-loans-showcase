"use client";

import { formatBp } from "@/lib/format";
import { ArrowRight, TabletSmartphone } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import { LocalTime } from "@/components/data/local-time";
import { Money } from "@/components/data/money";
import { StatusBadge } from "@/components/data/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { TabletPreview, TabletPreviewItem } from "@/server/mortgages/tablet";
import { commitTabletAction, previewTabletAction } from "../actions";

const pct = (bp: number | null) => (bp === null ? "—" : formatBp(bp));

/** For a possible duplicate: an existing mortgage's id, "new" or "skip". */
type Decision = string;

function Badge({ m }: { m: TabletPreviewItem["match"] }) {
  switch (m.kind) {
    case "matched":
      return <StatusBadge tone={m.firstPaste ? "success" : "info"}>{m.firstPaste ? "Adds details" : "Updates details"}</StatusBadge>;
    case "new":
      return <StatusBadge tone="warning">Not in the bank data yet</StatusBadge>;
    case "possible_duplicate":
      return <StatusBadge tone="warning">Possible duplicate</StatusBadge>;
    case "refused":
      return <StatusBadge tone="danger">Can&rsquo;t be saved</StatusBadge>;
    case "ignored":
      return <StatusBadge tone="neutral">Skipped</StatusBadge>;
  }
}

function DuplicateChoice({ item, decision, decide }: { item: TabletPreviewItem; decision: Decision | undefined; decide: (d: Decision) => void }) {
  const m = item.match;
  if (m.kind !== "possible_duplicate") return null;
  const name = `dup-${item.index}`;
  const option = (value: string, label: ReactNode, disabled = false) => (
    <label key={value} className={cn("flex items-start gap-2 rounded-lg border px-3 py-2 text-sm", decision === value && "border-primary bg-primary/5", disabled && "opacity-60")}>
      <input type="radio" name={name} value={value} checked={decision === value} disabled={disabled} onChange={() => decide(value)} className="mt-0.5 size-4 accent-primary" />
      <span>{label}</span>
    </label>
  );
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-sm font-medium">
        {item.buyer?.name ?? "This buyer"} already has {m.candidates.length === 1 ? "a mortgage" : "mortgages"} this may be. Which is it?
      </legend>
      {m.candidates.map((c) =>
        option(
          c.id,
          <>
            Update <span className="font-medium">{c.address}</span>
            <span className="text-muted-foreground">
              {" "}
              · {c.priceCents !== null ? <Money cents={c.priceCents} /> : "price unknown"}
              {c.originatedAt ? (
                <>
                  {" "}
                  · started <LocalTime value={c.originatedAt} format="date" />
                </>
              ) : null}
              {c.pasted ? "" : " · details not pasted yet"}
            </span>
          </>,
        ),
      )}
      {option("new", m.newAllowed ? "It’s another property: add it as a new mortgage" : "Add as a new mortgage (not possible: the paste is incomplete)", !m.newAllowed)}
      {option("skip", "Skip this agreement")}
    </fieldset>
  );
}

function Item({ item, decision, decide }: { item: TabletPreviewItem; decision: Decision | undefined; decide: (d: Decision) => void }) {
  const m = item.match;
  const problems = m.kind === "refused" || m.kind === "possible_duplicate" ? m.problems : [];
  return (
    <Card size="sm" className={cn(m.kind === "refused" && "border-danger/40", m.kind === "possible_duplicate" && !decision && "border-warning/50")}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {item.addressRecognised ? item.address : <span className="text-danger">No address found</span>}
          {item.funding === "company" && m.kind !== "refused" ? <StatusBadge tone="info">Funded by Litt&rsquo;s</StatusBadge> : null}
          <Badge m={m} />
        </CardTitle>
        <CardDescription>
          {m.kind === "matched" ? (
            <>
              Matched by {m.how}
              {m.originatedAt ? (
                <>
                  {" "}
                  · started <LocalTime value={m.originatedAt} format="date" />
                </>
              ) : null}
              {m.changes.length ? <span className="text-warning"> · changes {m.changes.join(", ")}</span> : null}
            </>
          ) : m.kind === "new" ? (
            "It will be added now and linked to its bank payments when they're imported."
          ) : m.kind === "refused" ? (
            "Not enough to start a new mortgage record, so it won't be saved. Fix the copy on the tablet and paste again."
          ) : m.kind === "possible_duplicate" ? (
            "No mortgage has this address, but the same buyer has one with the same money."
          ) : (
            m.reason
          )}
        </CardDescription>
      </CardHeader>
      {m.kind !== "ignored" ? (
        <CardContent className="space-y-3">
          {item.skippedLines.length ? (
            <p className="text-xs text-muted-foreground">
              Left out above the address: {item.skippedLines.map((l) => `“${l}”`).join(", ")}
            </p>
          ) : null}
          {problems.length ? (
            <ul className="space-y-1 text-sm text-danger">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          ) : null}
          <DuplicateChoice item={item} decision={decision} decide={decide} />
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-muted-foreground">Buyer</dt>
              <dd>
                {item.buyer?.name ?? "—"} {item.buyer?.stateId ? <span className="ident text-muted-foreground">#{item.buyer.stateId}</span> : null}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Officer</dt>
              <dd>
                {item.officer ? (
                  <>
                    {item.officer.name}
                    {!item.officer.staffId ? <span className="block text-xs text-warning">Not a staff account</span> : null}
                  </>
                ) : (
                  "—"
                )}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Price · loan</dt>
              <dd>
                {item.priceCents !== null ? <Money cents={item.priceCents} /> : "—"} · {item.loanCents !== null ? <Money cents={item.loanCents} /> : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Weekly</dt>
              <dd>
                {item.weeklyCents !== null ? <Money cents={item.weeklyCents} /> : "—"} × {item.instalments ?? "?"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Broker · fed rate</dt>
              <dd>
                {pct(item.brokerRateBp)} · {pct(item.fedRateBp)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Banker fee</dt>
              <dd>{item.brokerFeeCents !== null ? <Money cents={item.brokerFeeCents} /> : "—"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Paid (tablet)</dt>
              <dd className="num">{item.paidCount ?? "—"}</dd>
            </div>
          </dl>
          {item.guidelines.length || item.warnings.length ? (
            <ul className="space-y-1 text-sm">
              {item.guidelines.map((g) => (
                <li key={g.text} className={g.level === "breach" ? "text-danger" : "text-warning"}>
                  {g.level === "breach" ? "Breach: " : "Check: "}
                  {g.text}
                </li>
              ))}
              {item.warnings.map((w) => (
                <li key={w} className="text-warning">
                  {w}
                </li>
              ))}
            </ul>
          ) : null}
        </CardContent>
      ) : null}
    </Card>
  );
}

export function TabletWorkflow() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<TabletPreview | null>(null);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run() {
    setError(null);
    startTransition(async () => {
      const r = await previewTabletAction({ text });
      if (!r.ok) return setError(r.error);
      setPreview(r.data);
      setDecisions({});
    });
  }

  function commit() {
    setError(null);
    startTransition(async () => {
      const r = await commitTabletAction({ text, decisions });
      if (!r.ok) return setError(r.error);
      const { updated, created, refused } = r.data;
      toast.success(
        `Saved ${updated + created} agreement${updated + created === 1 ? "" : "s"}${created ? ` (${created} new)` : ""}${refused ? `; ${refused} not saved` : ""}.`,
      );
      setPreview(null);
      setText("");
      setDecisions({});
      router.refresh();
    });
  }

  if (preview) {
    const unresolved = preview.items.filter((i) => i.match.kind === "possible_duplicate" && !decisions[i.index]).length;
    const saving = preview.items.filter((i) => {
      const k = i.match.kind;
      if (k === "possible_duplicate") return decisions[i.index] !== undefined && decisions[i.index] !== "skip";
      return k === "matched" || k === "new";
    }).length;
    const refused = preview.items.filter((i) => i.match.kind === "refused").length;
    return (
      <div className="max-w-4xl space-y-4">
        {preview.items.map((item) => (
          <Item key={item.index} item={item} decision={decisions[item.index]} decide={(d) => setDecisions((all) => ({ ...all, [item.index]: d }))} />
        ))}
        {preview.ignoredLines.length ? (
          <p className="text-xs text-muted-foreground">
            Ignored {preview.ignoredLines.length} line{preview.ignoredLines.length === 1 ? "" : "s"} after the last agreement.
          </p>
        ) : null}
        {error ? <FieldError>{error}</FieldError> : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={commit} disabled={pending || saving === 0 || unresolved > 0}>
            {pending ? <Spinner /> : null}
            Save {saving} agreement{saving === 1 ? "" : "s"} <ArrowRight aria-hidden />
          </Button>
          <Button variant="outline" onClick={() => setPreview(null)} disabled={pending}>
            Back
          </Button>
          {unresolved > 0 ? (
            <span className="text-sm text-warning">
              Say which mortgage {unresolved === 1 ? "the possible duplicate is" : `the ${unresolved} possible duplicates are`} first.
            </span>
          ) : refused > 0 ? (
            <span className="text-sm text-danger">
              {refused} agreement{refused === 1 ? "" : "s"} won&rsquo;t be saved.
            </span>
          ) : null}
          <Link href="/mortgages" className="ml-auto text-sm text-muted-foreground underline-offset-4 hover:underline">
            Cancel
          </Link>
        </div>
      </div>
    );
  }

  return (
    <Card className="max-w-4xl">
      <CardHeader>
        <CardTitle>Paste agreements</CardTitle>
        <CardDescription>Nothing is saved until you&rsquo;ve checked the preview.</CardDescription>
      </CardHeader>
      <CardContent>
        <form method="post"
          onSubmit={(e) => {
            e.preventDefault();
            run();
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="tablet">Agreement text</FieldLabel>
              <Textarea
                id="tablet"
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={16}
                className="font-mono text-xs"
                placeholder={"Paste one or more sale agreements here.\n\nEach starts at the address line (e.g. 117 Invention Ct) and ends at the “After Tax” amount."}
                spellCheck={false}
              />
              <FieldDescription>
                On the tablet, open &ldquo;Loan details&rdquo; first, then copy from the address line (e.g. &ldquo;117 Invention Ct&rdquo;) down to the &ldquo;After Tax&rdquo; amount.
                The tablet is the source for terms and parties; money always comes from the bank export.
              </FieldDescription>
            </Field>
            {error ? <FieldError>{error}</FieldError> : null}
            <div>
              <Button type="submit" disabled={pending || !text.trim()}>
                {pending ? <Spinner /> : <TabletSmartphone aria-hidden />}
                Preview
              </Button>
            </div>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
