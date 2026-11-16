"use client";

import { formatCents } from "@/lib/format";
import { BadgeCheck, CircleAlert, Clock, Info, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { startNavigationProgress } from "@/components/app-shell/navigation-progress";
import { Money } from "@/components/data/money";
import { AffixInput } from "@/components/forms/affix-input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import type { AllowanceRule } from "@/domain/mortgages/allowance";
import { allowanceTaken, balanceBefore, type AllowanceLine } from "@/domain/mortgages/allowance-outlook";
import { bandLabel, federalBandFor } from "@/domain/mortgages/federal";
import { federalMaximumBreaches, quoteChecks, quoteMortgage, type MortgageQuoteInput } from "@/domain/origination/mortgage-quote";
import type { Settings } from "@/domain/settings";
import { useNow } from "@/hooks/use-now";
import { toLocalInput } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { saveQuoteAction } from "./actions";

export type QuoteDraft = {
  id: string | null;
  buyerStateId: string;
  buyerName: string;
  address: string;
  price: string;
  agencyCommission: string;
  downPayment: string;
  termMonths: string;
  fedRate: string;
  brokerRate: string;
  primaryResidence: boolean;
  companyFunded: boolean;
  /** Empty: the federal maximum for the mortgage's band. */
  bankerFee: string;
  notes: string;
  /** ISO, as stored; the field shows it in the browser's time once hydrated. */
  expectedSigningAt: string | null;
  /** "signed": confirmed and marked signed in game. */
  status: "draft" | "confirmed" | "signed";
};

/** The server refuses a new signing time more than this far in the past (clock skew). */
const SKEW_MS = 5 * 60_000;

const toNumber = (s: string) => {
  const n = Number(s.replace(/[$,%\s]/g, ""));
  return s.trim() && Number.isFinite(n) ? n : null;
};

/** The officer's quote: live tablet figures and handbook §4A checks while they negotiate. */
export function QuoteForm({
  initial,
  settings,
  originatorPct,
  allowance,
  approval,
}: {
  initial: QuoteDraft;
  settings: Settings["mortgages"];
  originatorPct: number;
  /** The projected State allowance without this quote (research/19 §4); null without a reading. */
  allowance: { line: AllowanceLine; rule: AllowanceRule } | null;
  /** Executive approval (research/18): the line, whether this viewer's save approves it, and who approved it already. */
  approval: { lineCents: number; approvesOwn: boolean; approvedBy: string | null };
}) {
  const router = useRouter();
  const [d, setD] = useState<QuoteDraft>(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const set = <K extends keyof QuoteDraft>(k: K, v: QuoteDraft[K]) => setD((x) => ({ ...x, [k]: v }));
  // Signing time: the field shows the stored time in the browser's zone once hydrated, and the stored value is sent
  // back unchanged until the officer edits it (null clears it).
  const now = useNow();
  const [signingInput, setSigning] = useState<string | null>(null);
  const signing = signingInput ?? (now !== null && initial.expectedSigningAt ? toLocalInput(Date.parse(initial.expectedSigningAt)) : "");
  const signingMs = signingInput === null ? (initial.expectedSigningAt ? Date.parse(initial.expectedSigningAt) : Number.NaN) : signingInput ? new Date(signingInput).getTime() : Number.NaN;
  const hasSigning = Number.isFinite(signingMs);
  const signingIso = signingInput === null ? initial.expectedSigningAt : hasSigning ? new Date(signingMs).toISOString() : null;
  const signingPast = signingInput !== null && hasSigning && now !== null && signingMs < now - SKEW_MS;

  const price = toNumber(d.price);
  // The federal band follows down payment + loan = price − agency commission (research/17).
  const baseCents = price && price > 0 ? (Math.round(price) - Math.round(toNumber(d.agencyCommission) ?? 0)) * 100 : null;
  const band = baseCents !== null && baseCents > 0 ? federalBandFor(baseCents, settings) : null;
  const input: MortgageQuoteInput | null =
    price && price > 0
      ? {
          priceCents: Math.round(price) * 100,
          agencyCommissionCents: Math.round(toNumber(d.agencyCommission) ?? 0) * 100,
          downPaymentPct: toNumber(d.downPayment) ?? 0,
          termMonths: Math.round(toNumber(d.termMonths) ?? 0),
          fedRatePct: d.companyFunded ? 0 : (toNumber(d.fedRate) ?? 0),
          brokerRatePct: toNumber(d.brokerRate) ?? 0,
          bankerFeePct: toNumber(d.bankerFee) ?? band?.bankerFeeMaxPct ?? 0,
          primaryResidence: d.primaryResidence,
          companyFunded: d.companyFunded,
        }
      : null;
  const ok = input && input.agencyCommissionCents < input.priceCents && input.termMonths >= 1;
  const q = ok ? quoteMortgage(input) : null;
  // The State allowance at the signing time (or now, less the confirmed signings ahead, without one).
  const allowanceBeforeCents = allowance && !d.companyFunded ? (hasSigning ? balanceBefore(allowance.line, signingMs) : allowance.line.nowCents - allowance.line.confirmedCents) : null;
  const allowanceAfterCents = allowance && allowanceBeforeCents !== null && q ? allowanceBeforeCents - allowanceTaken(allowance.rule, q.loanCents) : null;
  const checks = [
    ...(ok && q ? quoteChecks(input, q, settings) : []),
    ...(allowanceBeforeCents !== null && allowanceAfterCents !== null && allowanceAfterCents < 0
      ? [{ level: "warning" as const, text: `The loan is more than the State allowance projected for its signing (${formatCents(allowanceBeforeCents)})` }]
      : []),
  ];
  const blocked = federalMaximumBreaches(checks).length > 0;
  const overLine = baseCents !== null && baseCents > approval.lineCents;
  const originatorCents = q ? Math.floor((q.bankerFeeCents * originatorPct) / 100 / 100) * 100 : 0;

  const submit = () => {
    setError(null);
    const sid = toNumber(d.buyerStateId);
    if (!sid) return setError("Give the buyer’s State ID.");
    if (!input) return setError("Give the property’s total value.");
    if (input.agencyCommissionCents >= input.priceCents) return setError("The agency’s commission can’t be the whole price.");
    if (input.termMonths < 1 || input.termMonths > 24) return setError("The term must be between 1 and 24 months.");
    if (input.downPaymentPct >= 100) return setError("The down payment can’t be the whole price. That’s a cash sale, not a mortgage.");
    if (!ok) return setError("Fill in the price, the agency’s commission and the term.");
    if (blocked) return setError("The quote is over the federal maximums. Lower the banker fee or broker rate to save it.");
    if (initial.status !== "draft" && !signingIso) return setError("A confirmed quote needs its signing time.");
    if (signingPast) return setError("The signing time can’t be in the past.");
    startTransition(async () => {
      const r = await saveQuoteAction(
        {
          buyerStateId: sid,
          buyerName: d.buyerName,
          address: d.address,
          priceDollars: Math.round(price!),
          agencyCommissionDollars: input.agencyCommissionCents / 100,
          downPaymentPct: input.downPaymentPct,
          termMonths: input.termMonths,
          fedRatePct: input.fedRatePct,
          brokerRatePct: input.brokerRatePct,
          bankerFeePct: input.bankerFeePct,
          primaryResidence: d.primaryResidence,
          companyFunded: d.companyFunded,
          notes: d.notes,
          expectedSigningAt: signingIso,
        },
        d.id,
      );
      if (!r.ok) return setError(r.error);
      toast.success(r.data.backToDraft ? "Saved. The quote is a draft again — confirm it when the terms are final." : "Quote saved.");
      startNavigationProgress();
      router.push(`/mortgages/quotes/${r.data.id}`);
    });
  };

  return (
    <form
      method="post"
      className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="min-w-0 space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Buyer and property</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-[10rem_minmax(0,1fr)]">
            <Field>
              <FieldLabel htmlFor="sid">Buyer&rsquo;s State ID</FieldLabel>
              <AffixInput id="sid" value={d.buyerStateId} onChange={(v) => set("buyerStateId", v)} className="ident" />
            </Field>
            <Field>
              <FieldLabel htmlFor="name">Buyer&rsquo;s name</FieldLabel>
              <Input id="name" value={d.buyerName} onChange={(e) => set("buyerName", e.target.value)} maxLength={80} />
            </Field>
            <Field className="sm:col-span-2">
              <FieldLabel htmlFor="address">Property address</FieldLabel>
              <Input id="address" value={d.address} onChange={(e) => set("address", e.target.value)} maxLength={120} placeholder="e.g. 117 Invention Ct" />
            </Field>
            <Field className="sm:col-span-2">
              <FieldLabel htmlFor="expected-signing">Expected signing (when the bidding closes)</FieldLabel>
              <Input
                id="expected-signing"
                type="datetime-local"
                className="w-fit"
                value={signing}
                onChange={(e) => setSigning(e.target.value)}
                required={initial.status !== "draft"}
                aria-invalid={signingPast || undefined}
              />
              {signingPast ? (
                <FieldError>The signing time can&rsquo;t be in the past.</FieldError>
              ) : (
                <FieldDescription>
                  {initial.status === "draft" ? "Your time. Optional until the quote is confirmed." : "Your time. Moving it keeps the quote confirmed."}
                </FieldDescription>
              )}
            </Field>
            <label className="flex items-start gap-2 text-sm sm:col-span-2">
              <input type="checkbox" className="mt-0.5 size-4 accent-primary" checked={d.primaryResidence} onChange={(e) => set("primaryResidence", e.target.checked)} />
              <span>
                <span className="font-medium">Their primary residence</span>
                <span className="block text-xs text-muted-foreground">
                  Fed rate at least {settings.fedRateMinPct}% for a first home, {settings.fedRateSecondHomeMinPct}% for any other property; higher for worse charges (handbook §4A).
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm sm:col-span-2">
              <input type="checkbox" className="mt-0.5 size-4 accent-primary" checked={d.companyFunded} onChange={(e) => set("companyFunded", e.target.checked)} />
              <span>
                <span className="font-medium">Company-funded</span>
                <span className="block text-xs text-muted-foreground">Litt&rsquo;s lends the money instead of the State: no fed rate, and the federal maximums don&rsquo;t apply.</span>
              </span>
            </label>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Terms</CardTitle>
            <CardDescription>
              Start the broker rate at {settings.brokerRateStartPct}%.{" "}
              {d.companyFunded
                ? "Company-funded: the federal maximums don’t apply."
                : band
                  ? `Federal maximums for mortgages ${bandLabel(band)} (down payment + loan): banker fee ${band.bankerFeeMaxPct}%, broker rate ${band.brokerRateMaxPct}%. A quote over them can’t be saved.`
                  : "The federal maximums for the banker fee and broker rate depend on the mortgage’s size; fill in the price to see them."}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="price">Total value</FieldLabel>
              <AffixInput id="price" value={d.price} onChange={(v) => set("price", v)} prefix="$" money />
              <FieldDescription>The sale price on the tablet, agency commission included.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="agency">Agency commission</FieldLabel>
              <AffixInput id="agency" value={d.agencyCommission} onChange={(v) => set("agencyCommission", v)} prefix="$" money />
              <FieldDescription>Paid by the buyer at signing; not lent.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="down">Down payment</FieldLabel>
              <AffixInput id="down" value={d.downPayment} onChange={(v) => set("downPayment", v)} suffix="%" decimals />
              <FieldDescription>At least {settings.downPaymentMinPct}%.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="term">Term</FieldLabel>
              <AffixInput id="term" value={d.termMonths} onChange={(v) => set("termMonths", v)} suffix="months" />
              <FieldDescription>{q ? `${q.instalments} weekly payments.` : "Paid weekly."}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="fed">Fed rate</FieldLabel>
              <AffixInput id="fed" value={d.companyFunded ? "" : d.fedRate} onChange={(v) => set("fedRate", v)} suffix="%" decimals disabled={d.companyFunded} />
              <FieldDescription>{d.companyFunded ? "None: Litt’s lends the money." : "The State’s interest, set from the buyer’s record."}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="broker">Broker rate</FieldLabel>
              <AffixInput id="broker" value={d.brokerRate} onChange={(v) => set("brokerRate", v)} suffix="%" decimals />
              <FieldDescription>Litt&rsquo;s interest.{band && !d.companyFunded ? ` At most ${band.brokerRateMaxPct}%.` : ""}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="fee">Banker fee</FieldLabel>
              <AffixInput id="fee" value={d.bankerFee} onChange={(v) => set("bankerFee", v)} suffix="%" decimals placeholder={band ? String(band.bankerFeeMaxPct) : undefined} />
              <FieldDescription>
                Of down payment + loan.{band && !d.companyFunded ? ` At most ${band.bankerFeeMaxPct}%.` : ""}
                {band && !d.bankerFee.trim() ? ` Left empty, it’s ${band.bankerFeeMaxPct}%.` : ""}
              </FieldDescription>
            </Field>
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
            <CardTitle>What the tablet will show</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {q ? (
              <dl className="divide-y">
                {(
                  [
                    ["Down payment", <Money key="d" cents={q.downPaymentCents} />],
                    ["Loan", <Money key="l" cents={q.loanCents} />],
                    ["Weekly payment", <Money key="w" cents={q.weeklyCents} />],
                    ...(q.lastWeeklyCents !== q.weeklyCents ? [["Final payment", <Money key="f" cents={q.lastWeeklyCents} />]] : []),
                    ["Broker interest", <Money key="b" cents={q.brokerInterestCents} />],
                    ["Federal interest", <Money key="fi" cents={q.federalInterestCents} />],
                    ["Banker fee", <Money key="bf" cents={q.bankerFeeCents} />],
                    ["Buyer pays at signing", <Money key="s" cents={q.dueAtSigningCents} />],
                    ["Litt’s earns", <Money key="e" cents={q.littsEarnsCents} />],
                    [`Your share of the fee (${originatorPct}%)`, <Money key="o" cents={originatorCents} />],
                    ...(allowanceBeforeCents !== null && allowanceAfterCents !== null
                      ? [
                          [hasSigning ? "State allowance at signing" : "Allowance now less confirmed signings", <Money key="ab" cents={allowanceBeforeCents} />],
                          ["State allowance left after this", <Money key="aa" cents={allowanceAfterCents} />],
                        ]
                      : []),
                  ] as [string, React.ReactNode][]
                ).map(([k, v]) => (
                  <div key={k} className="flex items-baseline justify-between gap-3 py-1.5">
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="num font-medium">{v}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="text-muted-foreground">Fill in the price and term to see the figures.</p>
            )}
            <p className="text-xs text-muted-foreground">
              At signing the buyer pays the down payment, banker fee, agency commission and 5% tax. Litt&rsquo;s earns is before tax and commission.
            </p>
          </CardContent>
        </Card>

        {checks.length ? (
          <Card>
            <CardHeader>
              <CardTitle>Checks</CardTitle>
              <CardDescription>{blocked ? "Over the federal maximums: this quote can’t be saved." : "Handbook §4A guidance."}</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2 text-sm">
                {checks.map((f, i) => {
                  const Icon = f.level === "breach" ? CircleAlert : TriangleAlert;
                  return (
                    <li key={i} className="flex items-start gap-2">
                      <Icon className={cn("mt-0.5 size-4 shrink-0", f.level === "breach" ? "text-danger" : "text-warning")} aria-hidden />
                      <span className={cn(f.level === "breach" && "font-medium")}>{f.text}</span>
                    </li>
                  );
                })}
              </ul>
            </CardContent>
          </Card>
        ) : null}

        {overLine ? (
          approval.approvesOwn ? (
            <Alert variant="success">
              <BadgeCheck aria-hidden />
              <AlertTitle>Over {formatCents(approval.lineCents)}: executive approval</AlertTitle>
              <AlertDescription>You&rsquo;re an executive, so saving approves it.</AlertDescription>
            </Alert>
          ) : approval.approvedBy ? (
            <Alert variant="warning">
              <TriangleAlert aria-hidden />
              <AlertTitle>Approved by {approval.approvedBy}</AlertTitle>
              <AlertDescription>Changing the terms clears the approval, and the quote goes back to an executive before it can go on the tablet.</AlertDescription>
            </Alert>
          ) : (
            <Alert variant="warning">
              <Clock aria-hidden />
              <AlertTitle>Over {formatCents(approval.lineCents)}: needs an executive&rsquo;s approval</AlertTitle>
              <AlertDescription>Down payment + loan is over the line, so an executive must approve the quote before it goes on the tablet. They&rsquo;re told when you save it.</AlertDescription>
            </Alert>
          )
        ) : null}

        {initial.status === "confirmed" ? (
          <Alert variant="info">
            <Info aria-hidden />
            <AlertTitle>Changing the figures moves it back to Draft.</AlertTitle>
            <AlertDescription>Confirm it again after saving. Moving only the signing time keeps it confirmed.</AlertDescription>
          </Alert>
        ) : null}
        {error ? <FieldError>{error}</FieldError> : null}
        <Button type="submit" disabled={pending || blocked}>
          {pending ? <Spinner /> : null}
          Save quote
        </Button>
        <p className="text-xs text-muted-foreground">It links itself to the mortgage once the sale agreement is pasted.</p>
      </div>
    </form>
  );
}
