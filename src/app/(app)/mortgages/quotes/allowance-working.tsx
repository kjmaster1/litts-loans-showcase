import { CircleAlert, CircleCheck, TriangleAlert } from "lucide-react";
import { LocalTime } from "@/components/data/local-time";
import { Money } from "@/components/data/money";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { ConfirmView } from "@/domain/mortgages/allowance-outlook";
import { formatCents, formatDollars } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The State allowance on a quote's signing day (research/19 §4): the working that adds up to it, and the verdict.
 * Shared by the Confirm dialog (client) and the quote page's "Allowance on signing day" card (server).
 */

const plural = (n: number, one: string) => `${n === 0 ? "no" : n} ${n === 1 ? one : `${one}s`}`;

function Signed({ cents, className }: { cents: number; className?: string }) {
  return <span className={cn("num whitespace-nowrap", className)}>{`${cents < 0 ? "−" : cents > 0 ? "+" : ""}${formatCents(Math.abs(cents))}`}</span>;
}

function Row({ label, total, children }: { label: string; total?: boolean; children: React.ReactNode }) {
  return (
    <div className={cn("flex items-baseline justify-between gap-3 py-0.5", total && "mt-1 border-t pt-1.5 font-semibold")}>
      <dt className={cn(!total && "text-muted-foreground")}>{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

/** nowCents + repayments − signings = before; before − this loan = after. */
export function AllowanceWorking({ view, className }: { view: ConfirmView; className?: string }) {
  const { repayments, signings, quote } = view;
  const numbers = signings.numbers.length ? ` (${signings.numbers.map((n) => `#${n}`).join(", ")})` : "";
  return (
    <div className={cn("space-y-1.5", className)}>
      <dl className="rounded-lg border bg-muted/40 px-3 py-2 text-sm">
        <Row label="Allowance now">
          <Money cents={view.nowCents} />
        </Row>
        <Row label={`+ ${plural(repayments.count, "repayment")} due before then`}>
          <Signed cents={repayments.cents} />
        </Row>
        <Row label={`− ${plural(signings.numbers.length, "confirmed signing")} before then${numbers}`}>
          <Signed cents={-signings.cents} />
        </Row>
        <Row label="= Allowance just before signing" total>
          <Money cents={quote.beforeCents} />
        </Row>
        <Row label="− this loan">
          <Signed cents={quote.afterCents - quote.beforeCents} className={cn(quote.afterCents < 0 && "text-danger")} />
        </Row>
        <Row label="= After signing" total>
          <Money cents={quote.afterCents} />
        </Row>
      </dl>
      <p className="text-xs text-muted-foreground">
        {view.rule.source === "none"
          ? "No allowance rule adopted, so repayments aren’t projected. Signings take the full loan."
          : `Rule: ${view.rule.label}${view.rule.source === "best_fit" ? " (best fit, not adopted)" : ""}.`}
      </p>
    </div>
  );
}

/** "Draft" is the quote page's what-if; "confirmed" has no fits-from search (the outlook doesn't run one). */
export type VerdictContext = "dialog" | "draft" | "confirmed";

function KnockOnOwner({ k, context }: { k: ConfirmView["knockOn"][number]; context: VerdictContext }) {
  if (k.yours) return <>It&rsquo;s your quote.</>;
  const who = k.officerName ?? "another officer";
  return <>It&rsquo;s {who}&rsquo;s quote; they&rsquo;ll be notified{context === "dialog" ? "" : " if this one is confirmed"}.</>;
}

function KnockOnText({ view, context, also }: { view: ConfirmView; context: VerdictContext; also: boolean }) {
  const [first, ...rest] = view.knockOn;
  if (!first) return null;
  if (!rest.length) {
    return (
      <>
        {also ? "" : "This fits, but "}#{first.number} ({first.address}
        {first.signingAt ? (
          <>
            , <LocalTime value={first.signingAt} />
          </>
        ) : null}
        ) would then be short by {formatDollars(first.shortByCents)}
        {also ? " too" : ""}. <KnockOnOwner k={first} context={context} />
      </>
    );
  }
  return (
    <>
      {also ? "These confirmed quotes would then be short too:" : "This fits, but these confirmed quotes would then be short:"}
      <ul className="mt-1 list-disc pl-5">
        {view.knockOn.map((k) => (
          <li key={k.number}>
            #{k.number} ({k.address}
            {k.signingAt ? (
              <>
                , <LocalTime value={k.signingAt} />
              </>
            ) : null}
            ): short by {formatDollars(k.shortByCents)}. <KnockOnOwner k={k} context={context} />
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * Short, a later confirmed quote pushed short, Tight or Fits. `announce` gives it role="alert": only once the officer
 * has changed something, never on first paint.
 */
export function VerdictAlert({ view, context, announce = false }: { view: ConfirmView; context: VerdictContext; announce?: boolean }) {
  const { quote } = view;
  const role = announce ? "alert" : undefined;
  if (quote.verdict === "short") {
    return (
      <Alert variant="danger" role={role}>
        <CircleAlert aria-hidden />
        <AlertTitle>
          Short by {formatDollars(-quote.afterCents)} on <LocalTime value={quote.signingAt} />.
        </AlertTitle>
        <AlertDescription>
          <p>
            {quote.fitsFrom ? (
              <>
                It would fit from about <LocalTime value={quote.fitsFrom} />.
              </>
            ) : context === "confirmed" ? null : (
              "It doesn’t fit within 60 days."
            )}
            {context === "dialog" ? " You can still confirm it." : null}
          </p>
          {view.knockOn.length ? (
            <div className="mt-1">
              <KnockOnText view={view} context={context} also />
            </div>
          ) : null}
        </AlertDescription>
      </Alert>
    );
  }
  if (view.knockOn.length) {
    return (
      <Alert variant="danger" role={role}>
        <TriangleAlert aria-hidden />
        <AlertDescription>
          <KnockOnText view={view} context={context} also={false} />
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert variant={quote.verdict === "tight" ? "warning" : "success"} role={role}>
      {quote.verdict === "tight" ? <TriangleAlert aria-hidden /> : <CircleCheck aria-hidden />}
      <AlertTitle>
        {quote.verdict === "tight"
          ? `It fits, but leaves only ${formatDollars(quote.afterCents)} — less than the ${formatDollars(view.cushionCents)} cushion.`
          : `It fits, with ${formatDollars(quote.afterCents)} left after.`}
      </AlertTitle>
    </Alert>
  );
}

/** A warning the officer should see before confirming: Short, or a later confirmed quote pushed short. */
export function hasWarning(view: ConfirmView): boolean {
  return view.quote.verdict === "short" || view.knockOn.length > 0;
}
