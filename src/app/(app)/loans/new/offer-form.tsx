"use client";

import { CircleAlert, Info, Sparkles, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { startNavigationProgress } from "@/components/app-shell/navigation-progress";
import { Money } from "@/components/data/money";
import { AffixInput } from "@/components/forms/affix-input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { LOAN_KIND_LABEL, LOAN_KINDS, offerChecks, offerFigures, suggestRate, suggestedDefaultFee, type BorrowerRecord, type LoanKind } from "@/domain/origination/loan-offer";
import type { Settings } from "@/domain/settings";
import { cn } from "@/lib/utils";
import { borrowerForOfferAction, saveOfferAction } from "../offers/actions";

type Lending = { name: string | null; record: BorrowerRecord; flags: { level: "danger" | "warning" | "info" | "good"; text: string }[] };

export type OfferDraft = {
  id: string | null;
  kind: LoanKind;
  borrowerStateId: string;
  borrowerName: string;
  amount: string;
  rate: string;
  stateRate: string;
  weeks: string;
  startsOn: string;
  collateral: string;
  collateralValue: string;
  purpose: string;
  weeklyIncome: string;
  defaultFee: string;
  notes: string;
  officerStaffId: string;
};

const toNumber = (s: string) => {
  const n = Number(s.replace(/[$,%\s]/g, ""));
  return s.trim() && Number.isFinite(n) ? n : null;
};
type FieldKey = "sid" | "name" | "amount" | "weeks" | "rate" | "starts" | "collateral";

/** The first missing or unusable answer, top to bottom as the form reads. */
function firstProblem(d: OfferDraft, n: { sid: number | null; amount: number | null; weeks: number | null; rate: number | null }): { field: FieldKey; message: string } | null {
  if (!n.sid) return { field: "sid", message: "Give the borrower’s State ID." };
  if (d.borrowerName.trim().length < 2) return { field: "name", message: "Give the borrower’s name." };
  if (!n.amount) return { field: "amount", message: "Give the loan amount." };
  if (!n.weeks) return { field: "weeks", message: "Give the number of weekly payments." };
  if (n.rate === null) return { field: "rate", message: "Give the interest rate." };
  if (d.kind !== "general" && d.collateral.trim().length < 2) {
    return { field: "collateral", message: d.kind === "vehicle" ? "Give the vehicle’s make & model." : "Give the property’s address." };
  }
  return null;
}

/** Which field a server message is about, when it names one. */
function fieldFor(message: string): FieldKey | null {
  if (/make & model|property’s address/.test(message)) return "collateral";
  if (/borrower’s name/.test(message)) return "name";
  if (/date/.test(message)) return "starts";
  return null;
}

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
const FLAG = {
  danger: { icon: CircleAlert, className: "text-danger" },
  warning: { icon: TriangleAlert, className: "text-warning" },
  info: { icon: Info, className: "text-muted-foreground" },
  good: { icon: Info, className: "text-success" },
} as const;

const KIND_HELP: Record<LoanKind, string> = {
  vehicle: "To buy a car. The vehicle is the collateral.",
  property: "To buy a property. The property is the collateral.",
  general: "Anything else. Collateral is optional; the contract states the purpose.",
};

export function OfferForm({
  initial,
  settings,
  officers,
}: {
  initial: OfferDraft;
  settings: Settings["loans"];
  /** Management+: may make the offer for another officer. */
  officers: { id: string; name: string }[] | null;
}) {
  const router = useRouter();
  const [d, setD] = useState<OfferDraft>(initial);
  const [lending, setLending] = useState<Lending | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The field a problem belongs to: marked, explained beside it and focused (UX review 2026-10-12 --
  // the message used to appear only by the buttons, a screen away from the empty field).
  const [badField, setBadField] = useState<FieldKey | null>(null);
  const [pending, startTransition] = useTransition();
  const [looking, startLooking] = useTransition();
  const [feeTouched, setFeeTouched] = useState(Boolean(initial.id));
  const set = <K extends keyof OfferDraft>(k: K, v: OfferDraft[K]) => setD((x) => ({ ...x, [k]: v }));

  // Look the borrower up when the State ID settles.
  const sid = toNumber(d.borrowerStateId);
  useEffect(() => {
    if (!sid || sid < 1) return;
    const t = setTimeout(() => {
      startLooking(async () => {
        const r = await borrowerForOfferAction(sid);
        if (!r.ok) return;
        setLending(r.data);
        if (r.data.name) setD((x) => (x.borrowerName.trim() ? x : { ...x, borrowerName: r.data.name! }));
      });
    }, 300);
    return () => clearTimeout(t);
  }, [sid]);

  const amount = toNumber(d.amount);
  const rate = toNumber(d.rate);
  const weeks = toNumber(d.weeks);
  const terms = useMemo(
    () =>
      amount && weeks
        ? {
            amountCents: Math.round(amount) * 100,
            ratePct: rate ?? 0,
            stateRatePct: toNumber(d.stateRate) ?? settings.stateRatePct,
            weeks: Math.round(weeks),
            startsOn: new Date(`${d.startsOn || today()}T12:00:00Z`),
            collateralValueCents: toNumber(d.collateralValue) ? Math.round(toNumber(d.collateralValue)!) * 100 : null,
            weeklyIncomeCents: toNumber(d.weeklyIncome) ? Math.round(toNumber(d.weeklyIncome)!) * 100 : null,
          }
        : null,
    [amount, rate, weeks, d.stateRate, d.startsOn, d.collateralValue, d.weeklyIncome, settings.stateRatePct],
  );
  const figures = terms ? offerFigures(terms) : null;
  const record = lending?.record ?? { repaid: 0, wentBad: 0, open: 0, doNotLend: false };
  const guide = terms ? suggestRate(d.kind, terms, record, settings) : null;
  // The Defaulted Account Fee follows the suggestion until the officer types their own.
  const feeText = feeTouched ? d.defaultFee : amount ? String(suggestedDefaultFee(Math.round(amount) * 100, settings) / 100) : "";
  const feeCents = toNumber(feeText) !== null ? Math.round(toNumber(feeText)!) * 100 : null;
  const checks = terms && figures ? offerChecks(d.kind, { ...terms, defaultFeePerDayCents: feeCents ?? 0 }, figures, settings) : [];

  const fail = (field: FieldKey | null, message: string) => {
    setError(message);
    setBadField(field);
    if (field) {
      const el = document.getElementById(field);
      el?.focus();
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  };
  const submit = (issue: boolean) => {
    setError(null);
    setBadField(null);
    const problem = firstProblem(d, { sid, amount, weeks, rate });
    if (problem || !sid || !amount || !weeks || rate === null) return fail(problem?.field ?? null, problem?.message ?? "Fill in the form.");
    startTransition(async () => {
      const r = await saveOfferAction(
        {
          kind: d.kind,
          borrowerStateId: sid,
          borrowerName: d.borrowerName,
          amountDollars: Math.round(amount),
          ratePct: rate,
          stateRatePct: toNumber(d.stateRate) ?? settings.stateRatePct,
          weeks: Math.round(weeks),
          startsOn: d.startsOn || today(),
          collateral: d.collateral || null,
          collateralValueDollars: toNumber(d.collateralValue) ? Math.round(toNumber(d.collateralValue)!) : null,
          purpose: d.purpose || null,
          weeklyIncomeDollars: toNumber(d.weeklyIncome) ? Math.round(toNumber(d.weeklyIncome)!) : null,
          defaultFeePerDayDollars: feeCents !== null ? feeCents / 100 : 0,
          suggestedRatePct: guide?.ratePct ?? null,
          notes: d.notes,
          officerStaffId: d.officerStaffId || null,
        },
        { id: d.id, issue },
      );
      if (!r.ok) return fail(fieldFor(r.error), r.error);
      toast.success(issue ? "Contract ready to copy." : "Saved as a draft.");
      startNavigationProgress();
      router.push(`/loans/offers/${r.data.id}`);
    });
  };

  const invalid = (f: FieldKey) => (badField === f ? { "aria-invalid": true as const, "aria-describedby": `${f}-error` } : {});
  const fieldError = (f: FieldKey) => (badField === f && error ? <FieldError id={`${f}-error`}>{error}</FieldError> : null);

  const collateralLabel = d.kind === "vehicle" ? "Vehicle make & model" : d.kind === "property" ? "Property address" : "Collateral (optional)";
  const valueLabel = d.kind === "vehicle" ? "Vehicle’s value" : d.kind === "property" ? "Property’s value" : "Collateral’s value";

  return (
    <form
      method="post"
      className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]"
      onSubmit={(e) => {
        e.preventDefault();
        submit(false);
      }}
    >
      <div className="min-w-0 space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Borrower and loan type</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <fieldset>
              <legend className="mb-2 text-sm font-medium">Type of loan</legend>
              <div className="grid gap-2 sm:grid-cols-3">
                {LOAN_KINDS.map((k) => (
                  <label
                    key={k}
                    className={cn(
                      "flex cursor-pointer flex-col gap-0.5 rounded-lg border p-3 text-sm has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50",
                      d.kind === k ? "border-primary bg-primary/5" : "hover:bg-muted/50",
                    )}
                  >
                    <input type="radio" name="kind" value={k} checked={d.kind === k} onChange={() => set("kind", k)} className="sr-only" />
                    <span className="font-medium">{LOAN_KIND_LABEL[k]}</span>
                    <span className="text-xs text-muted-foreground">{KIND_HELP[k]}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="grid gap-4 sm:grid-cols-[10rem_minmax(0,1fr)]">
              <Field>
                <FieldLabel htmlFor="sid">State ID</FieldLabel>
                <AffixInput id="sid" value={d.borrowerStateId} onChange={(v) => set("borrowerStateId", v)} placeholder="e.g. 40001" className="ident" {...invalid("sid")} />
                {fieldError("sid")}
              </Field>
              <Field>
                <FieldLabel htmlFor="name">Borrower&rsquo;s name</FieldLabel>
                <Input id="name" value={d.borrowerName} onChange={(e) => set("borrowerName", e.target.value)} placeholder="As on their ID" maxLength={80} {...invalid("name")} />
                {fieldError("name")}
                <FieldDescription>{looking ? "Looking them up…" : lending?.name ? "Found in Litt’s records." : sid ? "New to Litt’s." : "Filled in when they’re on record."}</FieldDescription>
              </Field>
            </div>
            {officers ? (
              <Field>
                <FieldLabel htmlFor="officer">Loan officer</FieldLabel>
                <Select value={d.officerStaffId} onValueChange={(v) => set("officerStaffId", String(v))} items={officers.map((o) => ({ value: o.id, label: o.name }))}>
                  <SelectTrigger id="officer" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {officers.map((o) => (
                      <SelectItem key={o.id} value={o.id}>
                        {o.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Terms</CardTitle>
            <CardDescription>
              Flat interest on the loan amount, never compounding. Officers may offer {settings.rateMinPct}–{settings.rateMaxPct}% without sign-off.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="amount">Loan amount</FieldLabel>
              <AffixInput id="amount" value={d.amount} onChange={(v) => set("amount", v)} placeholder="e.g. 50000" prefix="$" money {...invalid("amount")} />
              {fieldError("amount")}
            </Field>
            <Field>
              <FieldLabel htmlFor="weeks">Weeks</FieldLabel>
              <AffixInput id="weeks" value={d.weeks} onChange={(v) => set("weeks", v)} placeholder="e.g. 8" suffix="weeks" {...invalid("weeks")} />
              {fieldError("weeks")}
              <FieldDescription>One payment a week.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="rate">Interest rate</FieldLabel>
              <div className="flex gap-2">
                <AffixInput id="rate" value={d.rate} onChange={(v) => set("rate", v)} placeholder="e.g. 15" suffix="%" decimals {...invalid("rate")} />
                {guide && toNumber(d.rate) !== guide.ratePct ? (
                  <Button type="button" variant="outline" onClick={() => set("rate", String(guide.ratePct))}>
                    <Sparkles aria-hidden /> Use {guide.ratePct}%
                  </Button>
                ) : null}
              </div>
              {fieldError("rate")}
            </Field>
            <Field>
              <FieldLabel htmlFor="state-rate">State rate to enter in game</FieldLabel>
              <AffixInput id="state-rate" value={d.stateRate} onChange={(v) => set("stateRate", v)} suffix="%" decimals />
              <FieldDescription>Always {settings.stateRatePct}%. It comes off what Litt&rsquo;s gets back.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="starts">Contract date</FieldLabel>
              <Input id="starts" type="date" min={today()} value={d.startsOn} onChange={(e) => set("startsOn", e.target.value)} {...invalid("starts")} />
              {fieldError("starts")}
              <FieldDescription>First payment a week later.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="fee">Defaulted Account Fee</FieldLabel>
              <AffixInput
                id="fee"
                prefix="$"
                suffix="a day"
                money
                value={feeText}
                onChange={(v) => {
                  setFeeTouched(true);
                  set("defaultFee", v);
                }}
              />
              <FieldDescription>Suggested at {settings.defaultFeePerDayPct}% of the loan a day. You choose the amount.</FieldDescription>
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Collateral and affordability</CardTitle>
            <CardDescription>The handbook prices a loan on the asset&rsquo;s value, the loan-to-value and whether the weekly payment is affordable.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Field className="sm:col-span-2">
              <FieldLabel htmlFor="collateral">{collateralLabel}</FieldLabel>
              <Input
                id="collateral"
                value={d.collateral}
                onChange={(e) => set("collateral", e.target.value)}
                maxLength={200}
                placeholder={d.kind === "vehicle" ? "e.g. Bravado Buffalo STX" : d.kind === "property" ? "e.g. 103 South Rockford Dr" : "Leave empty for an unsecured loan"}
                {...invalid("collateral")}
              />
              {fieldError("collateral")}
            </Field>
            <Field>
              <FieldLabel htmlFor="value">{valueLabel}</FieldLabel>
              <AffixInput id="value" value={d.collateralValue} onChange={(v) => set("collateralValue", v)} prefix="$" money />
            </Field>
            <Field>
              <FieldLabel htmlFor="income">Borrower&rsquo;s weekly income</FieldLabel>
              <AffixInput id="income" value={d.weeklyIncome} onChange={(v) => set("weeklyIncome", v)} prefix="$" money suffix="a week" />
              <FieldDescription>As they state it.</FieldDescription>
            </Field>
            {d.kind === "general" ? (
              <Field className="sm:col-span-2">
                <FieldLabel htmlFor="purpose">What the loan is for</FieldLabel>
                <Input id="purpose" value={d.purpose} onChange={(e) => set("purpose", e.target.value)} maxLength={200} placeholder="Goes in the contract" />
              </Field>
            ) : null}
            <Field className="sm:col-span-2">
              <FieldLabel htmlFor="notes">Notes (staff only)</FieldLabel>
              <Textarea id="notes" rows={2} maxLength={2000} value={d.notes} onChange={(e) => set("notes", e.target.value)} />
            </Field>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-4 xl:sticky xl:top-16 xl:self-start">
        <Card>
          <CardHeader>
            <CardTitle>Summary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {figures ? (
              <dl className="divide-y">
                {(
                  [
                    ["Weekly payment", <Money key="w" cents={figures.weeklyCents} />],
                    ...(figures.lastCents !== figures.weeklyCents ? [["Final payment", <Money key="l" cents={figures.lastCents} />]] : []),
                    ["Total to repay", <Money key="t" cents={figures.totalCents} />],
                    ["Interest", <Money key="i" cents={figures.interestCents} />],
                    ["State’s share", <Money key="s" cents={figures.stateShareCents} />],
                    ["Litt’s earns", <Money key="e" cents={figures.littsEarnsCents} />],
                    ["Loan-to-value", figures.ltvPct === null ? "—" : `${Math.round(figures.ltvPct)}%`],
                    ["Of weekly income", figures.paymentToIncomePct === null ? "—" : `${Math.round(figures.paymentToIncomePct)}%`],
                  ] as [string, React.ReactNode][]
                ).map(([k, v]) => (
                  <div key={k} className="flex items-baseline justify-between gap-3 py-1.5">
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="num font-medium">{v}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="text-muted-foreground">Fill in the amount and weeks to see the payments.</p>
            )}
            <p className="text-xs text-muted-foreground">Litt&rsquo;s earns is before tax and commission. The game doesn&rsquo;t charge interest on the final payment (a game quirk).</p>
          </CardContent>
        </Card>

        {guide ? (
          <Card>
            <CardHeader>
              <CardTitle>Rate guide: {guide.ratePct}%</CardTitle>
              <CardDescription>From the handbook&rsquo;s factors and their record. A suggestion; you set the rate.</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1 text-sm">
                <li className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Starting point</span>
                  <span className="num">15%</span>
                </li>
                {guide.reasons.map((r) => (
                  <li key={r.text} className="flex justify-between gap-3">
                    <span>{r.text}</span>
                    <span className={cn("num", r.deltaPct > 0 ? "text-warning" : "text-success")}>
                      {r.deltaPct > 0 ? "+" : "−"}
                      {Math.abs(r.deltaPct)}
                    </span>
                  </li>
                ))}
                {guide.clamped ? <li className="text-xs text-muted-foreground">Kept within {settings.rateMinPct}–{settings.rateMaxPct}%.</li> : null}
              </ul>
            </CardContent>
          </Card>
        ) : null}

        {checks.length || lending?.flags.length ? (
          <Card>
            <CardHeader>
              <CardTitle>Checks</CardTitle>
              <CardDescription>Warnings only. You can still issue the contract.</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2 text-sm">
                {[...checks, ...(lending?.flags ?? [])].map((f, i) => {
                  const s = FLAG[f.level];
                  return (
                    <li key={i} className="flex items-start gap-2">
                      <s.icon className={cn("mt-0.5 size-4 shrink-0", s.className)} aria-hidden />
                      <span className={cn("[overflow-wrap:anywhere]", f.level === "danger" && "font-medium")}>{f.text}</span>
                    </li>
                  );
                })}
              </ul>
            </CardContent>
          </Card>
        ) : null}

        {error ? <FieldError role="alert">{badField ? `Check the highlighted field: ${error}` : error}</FieldError> : null}
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => submit(true)} disabled={pending}>
            {pending ? <Spinner /> : null}
            Issue contract
          </Button>
          <Button type="submit" variant="outline" disabled={pending}>
            Save draft
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">Issuing fixes the contract text; a draft can still be changed.</p>
      </div>
    </form>
  );
}
