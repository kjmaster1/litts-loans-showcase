import { Money } from "@/components/data/money";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { dayMonth } from "@/domain/commissions/week";
import type { Forecast, ForecastWeek } from "@/domain/forecast";
import { cn } from "@/lib/utils";

/** Expected receipts by week from running loans and mortgages (research/11). */
export function ForecastCard({ forecast }: { forecast: Forecast }) {
  const row = (label: React.ReactNode, w: ForecastWeek, muted = false) => (
    <TableRow key={w.key} className={cn(muted && "text-muted-foreground")}>
      <TableCell className="pl-6">{label}</TableCell>
      <TableCell className="text-right">
        <Money cents={w.loansCents} />
      </TableCell>
      <TableCell className="text-right">
        <Money cents={w.mortgagesCents} />
      </TableCell>
      <TableCell className="pr-6 text-right font-medium">
        <Money cents={w.totalCents} />
      </TableCell>
    </TableRow>
  );
  return (
    <Card id="forecast">
      <CardHeader>
        <CardTitle>Cash-flow forecast</CardTitle>
        <CardDescription>
          What running loans and mortgages should pay Litt&rsquo;s each week (Monday to Sunday), from their schedules. Before tax withheld at source;
          defaulted loans left out.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-6">Week</TableHead>
              <TableHead className="text-right">Loans</TableHead>
              <TableHead className="text-right">Mortgages</TableHead>
              <TableHead className="pr-6 text-right">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {forecast.overdue.totalCents ? row(<span className="text-warning">Overdue (should already have come in)</span>, forecast.overdue) : null}
            {forecast.weeks.map((w, i) => row(i === 0 ? `This week (w/c ${dayMonth(w.from)})` : `w/c ${dayMonth(w.from)}`, w))}
            {row("Later", forecast.later, true)}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell className="pl-6" colSpan={3}>
                All still to come
              </TableCell>
              <TableCell className="pr-6 text-right">
                <Money cents={forecast.totalCents} />
              </TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </CardContent>
    </Card>
  );
}
