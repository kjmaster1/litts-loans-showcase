import { Info, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { AllowanceOutlookChart } from "@/components/data/allowance-outlook-chart";
import { outlookChartData } from "@/components/data/allowance-outlook-points";
import { Kpi, StatStrip } from "@/components/data/kpi";
import { LocalTime } from "@/components/data/local-time";
import { Money } from "@/components/data/money";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { AllowanceOutlook } from "@/domain/mortgages/allowance-outlook";

/**
 * The State allowance outlook on the Quotes page (docs/research/19 §3, mockup A). A server component: the outlook
 * holds per-mortgage figures, so it is never handed to a client component; the chart gets `outlookChartData`, with
 * what the viewer can't see merged.
 */

const DAY_MS = 86_400_000;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function OutlookCard({
  outlook,
  canSeeFinance,
  now,
  cushionCents,
  drafts = false,
}: {
  outlook: AllowanceOutlook | null;
  canSeeFinance: boolean;
  now: Date;
  cushionCents: number;
  drafts?: boolean;
}) {
  if (!outlook) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>State allowance</h2>
          </CardTitle>
          <CardDescription>
            No reading recorded yet, so there’s nothing to project from.{" "}
            {canSeeFinance ? (
              <>
                Record one on{" "}
                <Link href="/finance/allowance" className="underline underline-offset-4 hover:text-foreground">
                  Finance › State allowance
                </Link>
                .
              </>
            ) : (
              "Management records readings on Finance."
            )}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const fortnight = outlook.horizon.getTime() - now.getTime() === 14 * DAY_MS;
  const signings = outlook.steps.filter((s) => s.kind === "signing").length;
  const staleDays = outlook.bankStale && outlook.bankTo ? Math.floor((now.getTime() - outlook.bankTo.getTime()) / DAY_MS) : null;
  const low = outlook.lowest;
  const lowNow = low.at.getTime() === now.getTime() && low.quoteNumber === null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{fortnight ? "State allowance — next 14 days" : <>State allowance — to <LocalTime value={outlook.horizon} format="date" /></>}</h2>
        </CardTitle>
        <CardDescription>
          {outlook.ruleSource === "none" ? null : (
            <>
              Rule: {outlook.rule.label}
              {outlook.ruleSource === "best_fit" ? " (best fit, not adopted)" : ""} ·{" "}
            </>
          )}
          from the reading of <LocalTime value={outlook.readingAt} />
          {outlook.bankTo ? (
            <>
              {" "}
              · bank data to <LocalTime value={outlook.bankTo} />
            </>
          ) : null}
          {outlook.behind > 0 ? ` · ${plural(outlook.behind, "mortgage")} behind on payments left out` : null}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {staleDays !== null ? (
          <p className="flex items-start gap-2 text-sm">
            <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
            Bank data is {plural(staleDays, "day")} old: repayments since then are estimated.
          </p>
        ) : null}
        {outlook.ruleSource === "none" ? (
          <Alert variant="info">
            <Info aria-hidden />
            <AlertTitle>No allowance rule adopted, so repayments aren’t projected.</AlertTitle>
            <AlertDescription>
              <p>
                Signings still take the full loan amount.{" "}
                {canSeeFinance ? (
                  <>
                    Adopt a rule on{" "}
                    <Link href="/finance/allowance" className="underline underline-offset-4">
                      Finance › State allowance
                    </Link>
                    .
                  </>
                ) : (
                  "Management adopts the rule on Finance."
                )}
              </p>
            </AlertDescription>
          </Alert>
        ) : null}
        <StatStrip cols={3}>
          <Kpi label="Allowance now" hint="the reading, plus repayments and signings since">
            <Money cents={outlook.nowCents} />
          </Kpi>
          <Kpi
            label="Lowest point ahead"
            tone={low.balanceCents < 0 ? "bad" : low.balanceCents < cushionCents ? "warn" : undefined}
            hint={
              lowNow ? (
                "now: nothing ahead takes it lower"
              ) : (
                <>
                  <LocalTime value={low.at} />
                  {low.quoteNumber !== null ? `, right after #${low.quoteNumber} signs` : null}
                </>
              )
            }
          >
            <Money cents={low.balanceCents} />
          </Kpi>
          <Kpi
            label={
              <span>
                At <LocalTime value={outlook.horizon} format="date" />
              </span>
            }
            hint={signings ? `after ${plural(signings, "confirmed signing")}` : "no confirmed signings before then"}
          >
            <Money cents={outlook.endCents} />
          </Kpi>
        </StatStrip>
        <AllowanceOutlookChart data={outlookChartData(outlook, drafts)} now={now} />
      </CardContent>
    </Card>
  );
}
