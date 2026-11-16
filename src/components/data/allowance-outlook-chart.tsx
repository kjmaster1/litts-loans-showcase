"use client";

import type { QuoteOutlook } from "@/domain/mortgages/allowance-outlook";
import { useTimeZone } from "@/hooks/use-time-zone";
import { COMPANY_TIMEZONE, zonedMidnight, zonedParts } from "@/lib/company-time";
import { dateFormat, formatDollars } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { OutlookChartData, OutlookPoint } from "./allowance-outlook-points";
import { ChartTable, compact } from "./charts";

/**
 * The State allowance outlook as a step chart (docs/research/19 §3, mockup A), drawn as SVG like `charts.tsx`. A client
 * component only so its times are the viewer's own (owner, 2026-10-20): it gets `OutlookChartData`, built on the
 * server with what the viewer can't see already merged, never the outlook. Until hydration it draws in UK time and says
 * so, like `LocalTime` showing UTC.
 */

const HOUR_MS = 3_600_000;
/** Rough width of one character of the 11-unit label text, for label placement. */
const CHAR_W = 6.6;

/** The chart's formatters for one zone; `own` = the viewer's, which the caption names, so times carry no suffix. */
type Clock = { timeZone: string; own: boolean; time: (d: Date) => string; when: (d: Date) => string; day: (d: Date) => string };

function clockFor(viewerZone: string | null): Clock {
  const timeZone = viewerZone ?? COMPANY_TIMEZONE;
  const dayTime = dateFormat({ weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone });
  const dayLabel = dateFormat({ weekday: "short", day: "numeric", timeZone });
  return {
    timeZone,
    own: viewerZone !== null,
    // "Thu 23 Oct, 02:00"; in running text (hover text, the summary) "… UK time" until the viewer's zone is known.
    time: (d) => dayTime.format(d),
    when: (d) => `${dayTime.format(d)}${viewerZone ? "" : " UK time"}`,
    day: (d) => dayLabel.format(d),
  };
}

const signedMoney = (cents: number) => `${cents < 0 ? "−" : "+"}${formatDollars(Math.abs(cents))}`;

/** Gridline values: a round step covering lo..hi (lo ≤ 0 ≤ hi). */
function niceStep(range: number): number {
  const raw = range / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
}

type Box = { x0: number; x1: number; y0: number; y1: number };
const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/**
 * Greedy label placement: right of the point, else left, then stepped up or down until it overlaps nothing placed
 * and stays inside the plot. Good enough for a handful of signings.
 */
function placer(bounds: Box) {
  const placed: Box[] = [];
  return {
    reserve(b: Box) {
      placed.push(b);
    },
    place(x: number, y: number, text: string, prefer: "up" | "down" = "up"): { x: number; y: number; anchor: "start" | "end" } {
      const w = text.length * CHAR_W;
      const offsets = [0, 1, -1, 2, -2, 3, -3, 4, -4].map((k) => (prefer === "up" ? -k : k) * 14);
      for (const dy of offsets) {
        for (const anchor of ["start", "end"] as const) {
          const tx = anchor === "start" ? x + 7 : x - 7;
          const ty = y + (prefer === "up" ? -7 : 14) + dy;
          const box = { x0: anchor === "start" ? tx : tx - w, x1: anchor === "start" ? tx + w : tx, y0: ty - 10, y1: ty + 3 };
          if (box.x0 < bounds.x0 || box.x1 > bounds.x1 || box.y0 < bounds.y0 || box.y1 > bounds.y1) continue;
          if (placed.some((p) => overlaps(p, box))) continue;
          placed.push(box);
          return { x: tx, y: ty, anchor };
        }
      }
      const tx = x + w + 7 > bounds.x1 ? x - 7 : x + 7;
      return { x: tx, y: y - 7, anchor: tx < x ? "end" : "start" };
    },
  };
}

/** A ring of card colour behind label text, so labels stay legible where they cross the line. */
const HALO = "stroke-card [paint-order:stroke] [stroke-linejoin:round] [stroke-width:3px]";

const DRAFT_STROKE: Record<QuoteOutlook["verdict"], string> = { short: "stroke-danger", tight: "stroke-warning", fits: "stroke-muted-foreground" };

/**
 * Two drawings of the same chart: `wide` from the `sm` breakpoint, `compact` on phones (a narrow viewBox, so its
 * 11-unit text stays about 11 px on a 390 px screen, four day labels, and "#N" labels with the amounts in the hover
 * text). Only one is displayed; the other is `display: none`, so assistive tech meets one image.
 */
type Variant = { W: number; H: number; pad: { l: number; r: number; t: number; b: number }; maxDays: number; compact: boolean };
const WIDE: Variant = { W: 720, H: 260, pad: { l: 52, r: 12, t: 26, b: 26 }, maxDays: 8, compact: false };
const COMPACT: Variant = { W: 340, H: 230, pad: { l: 40, r: 8, t: 24, b: 24 }, maxDays: 4, compact: true };

type PlotProps = { data: OutlookChartData; now: Date; summary: string; clock: Clock; variant: Variant; className: string };

function Plot({ data, now, summary, clock, variant, className }: PlotProps) {
  const { points, whatIfs } = data;
  const { W, H, pad } = variant;
  const t0 = now.getTime();
  const t1 = Math.max(data.horizon.getTime(), t0 + HOUR_MS);

  const values = [data.nowCents, ...points.map((p) => p.balanceCents), ...whatIfs.flatMap((d) => [d.beforeCents, d.afterCents])];
  const hi = Math.max(0, ...values);
  const lo0 = Math.min(0, ...values);
  // Always some room below zero, so the "short" band is visible even when nothing goes near it.
  const lo = lo0 - Math.max((hi - lo0) * 0.12, 1);
  const step = niceStep(hi - lo || 1);
  const top = Math.max(Math.ceil(hi / step) * step, step);
  const yTicks: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= top + 1e-6; v += step) yTicks.push(v);

  const x = (t: number) => pad.l + ((W - pad.l - pad.r) * (Math.min(Math.max(t, t0), t1) - t0)) / (t1 - t0);
  const y = (v: number) => pad.t + ((H - pad.t - pad.b) * (top - v)) / (top - lo);
  const balanceAt = (t: number) => points.filter((p) => p.at.getTime() <= t).at(-1)?.balanceCents ?? data.nowCents;

  let d = `M${x(t0).toFixed(1)},${y(data.nowCents).toFixed(1)}`;
  for (const p of points) d += `H${x(p.at.getTime()).toFixed(1)}V${y(p.balanceCents).toFixed(1)}`;
  d += `H${x(t1).toFixed(1)}`;

  // Day labels at midnights in the chart's zone, counted back from the last one so the end of the horizon is always
  // labelled.
  const first = zonedParts(new Date(t0), clock.timeZone);
  const days: Date[] = [];
  for (let i = 1; ; i++) {
    const m = zonedMidnight(first.year, first.month, first.day + i, clock.timeZone);
    if (m.getTime() > t1) break;
    days.push(m);
  }
  const every = Math.max(1, Math.ceil(days.length / variant.maxDays));
  const dayTicks = days.filter((_, i) => (days.length - 1 - i) % every === 0);

  const labels = placer({ x0: pad.l, x1: W - pad.r, y0: 0, y1: H - pad.b });
  labels.reserve({ x0: x(t0), x1: x(t0) + 30, y0: pad.t - 22, y1: pad.t - 8 });
  labels.reserve({ x0: pad.l, x1: pad.l + 44, y0: (y(0) + y(lo)) / 2 - 8, y1: (y(0) + y(lo)) / 2 + 6 });
  const signingLabels = points
    .filter((p) => p.kind === "signing")
    .map((p) => {
      const text = variant.compact ? `#${p.quoteNumber}` : `#${p.quoteNumber} signs · ${signedMoney(p.deltaCents)}`;
      return { text, at: labels.place(x(p.at.getTime()), y(p.beforeCents), text) };
    });
  const draftLabels = whatIfs.map((q) => {
    const text = variant.compact ? `#${q.number}` : `#${q.number} if signed · ${q.afterCents < 0 ? `short ${formatDollars(-q.afterCents)}` : `${formatDollars(q.afterCents)} left`}`;
    return { q, text, at: labels.place(x(q.signingAt.getTime()), y(q.afterCents), text, "down") };
  });
  const fitsFromLabels = whatIfs.flatMap((q) => {
    if (!q.fitsFrom || q.fitsFrom.getTime() > t1) return [];
    const at = q.fitsFrom.getTime();
    const title = `#${q.number} fits from ${clock.when(q.fitsFrom)}`;
    const text = variant.compact ? `#${q.number} fits` : title;
    return [{ q, at, title, text, label: labels.place(x(at), y(Math.max(balanceAt(at), 0)), text) }];
  });
  // One size for every label; CHAR_W assumes it.
  const font = "text-[11px]";

  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary} data-variant={variant.compact ? "compact" : "wide"} className={cn("h-auto w-full overflow-visible", className)}>
      <rect x={pad.l} y={y(0)} width={W - pad.l - pad.r} height={Math.max(0, y(lo) - y(0))} className="fill-danger-subtle" />
      {yTicks.map((t) => (
        <g key={t}>
          <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className={t === 0 ? "stroke-muted-foreground/60" : "stroke-border"} strokeWidth={t === 0 ? 1.25 : 1} />
          <text x={pad.l - 6} y={y(t)} dy="0.32em" textAnchor="end" className={cn("fill-muted-foreground", font)}>
            {t === 0 ? "$0" : t < 0 ? `−${compact(-t)}` : compact(t)}
          </text>
        </g>
      ))}
      <text x={pad.l + 6} y={(y(0) + y(lo)) / 2} dy="0.32em" className={cn("fill-danger font-medium", font)}>
        short
      </text>
      {dayTicks.map((m) => {
        const mx = x(m.getTime());
        const text = clock.day(m);
        const half = (text.length * CHAR_W) / 2;
        const anchor = mx + half > W ? "end" : mx - half < pad.l ? "start" : "middle";
        return (
          <g key={m.getTime()}>
            <line x1={mx} x2={mx} y1={H - pad.b} y2={H - pad.b + 4} className="stroke-border" />
            <text x={anchor === "end" ? W : mx} y={H - 8} textAnchor={anchor} data-day-tick="" className={cn("fill-muted-foreground", font)}>
              {text}
            </text>
          </g>
        );
      })}
      <line x1={x(t0)} x2={x(t0)} y1={pad.t - 6} y2={H - pad.b} className="stroke-foreground/70" strokeDasharray="2 3" />
      <text x={x(t0) + 4} y={pad.t - 12} className={cn("fill-foreground font-medium", font)}>
        now
      </text>

      <path d={d} className="fill-none stroke-chart-1" strokeWidth={2} strokeLinejoin="round" />

      {whatIfs.map((q) => {
        const qx = x(q.signingAt.getTime());
        return (
          <g key={q.quoteId}>
            <title>{`Draft #${q.number}, if signed ${clock.when(q.signingAt)}:${formatDollars(q.beforeCents)} before, ${q.afterCents < 0 ? `short by ${formatDollars(-q.afterCents)}` : `${formatDollars(q.afterCents)} left`} (not counted)`}</title>
            <line x1={qx} x2={qx} y1={y(q.beforeCents)} y2={y(q.afterCents)} className={DRAFT_STROKE[q.verdict]} strokeWidth={2} strokeDasharray="4 3" />
            <circle cx={qx} cy={y(q.beforeCents)} r={4} className={cn("fill-card", DRAFT_STROKE[q.verdict])} strokeWidth={2} />
            <rect x={qx - 6} y={y(q.beforeCents)} width={12} height={Math.max(12, y(q.afterCents) - y(q.beforeCents))} className="fill-transparent" />
          </g>
        );
      })}
      {fitsFromLabels.map(({ q, at, title }) => (
        <g key={`fits-${q.quoteId}`}>
          <title>{title}</title>
          <line x1={x(at)} x2={x(at)} y1={y(0)} y2={y(Math.max(balanceAt(at), 0))} className="stroke-success" strokeDasharray="2 3" strokeWidth={1.5} />
        </g>
      ))}

      {points.map((p, i) => {
        const px = x(p.at.getTime());
        const yA = y(p.beforeCents);
        const yB = y(p.balanceCents);
        return (
          <g key={i}>
            <title>{pointTitle(p, clock)}</title>
            <rect x={px - 5} y={Math.min(yA, yB) - 4} width={10} height={Math.abs(yB - yA) + 8} className="fill-transparent" />
            {p.kind === "signing" ? <circle cx={px} cy={yA} r={4} className="fill-chart-1 stroke-card" strokeWidth={2} /> : null}
          </g>
        );
      })}

      {signingLabels.map(({ text, at }, i) => (
        <text key={i} x={at.x} y={at.y} textAnchor={at.anchor} className={cn(HALO, "fill-foreground font-medium", font)}>
          {text}
        </text>
      ))}
      {draftLabels.map(({ q, text, at }) => (
        <text key={q.quoteId} x={at.x} y={at.y} textAnchor={at.anchor} className={cn(HALO, "fill-foreground", font)}>
          {text}
        </text>
      ))}
      {fitsFromLabels.map(({ q, text, label }) => (
        <text key={q.quoteId} x={label.x} y={label.y} textAnchor={label.anchor} className={cn(HALO, "fill-foreground", font)}>
          {text}
        </text>
      ))}
    </svg>
  );
}

/** Hover text of a point. */
function pointTitle(p: OutlookPoint, clock: Clock): string {
  return `${clock.when(p.at)} · ${p.what}${p.kind === "repayment" && !p.hidden ? " " : " · "}${signedMoney(p.deltaCents)}`;
}

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/** The written summary: the chart's accessible name. */
function chartSummary(data: OutlookChartData, now: Date, clock: Clock): string {
  const signings = data.points.filter((p) => p.kind === "signing").length;
  const { lowest } = data;
  const lowestNow = lowest.at.getTime() === now.getTime() && lowest.quoteNumber === null;
  const low = `lowest ${formatDollars(lowest.balanceCents)}${lowestNow ? " now" : ` on ${clock.when(lowest.at)}`}${lowest.quoteNumber !== null ? `, right after #${lowest.quoteNumber} signs` : ""}`;
  const shortDrafts = data.whatIfs.filter((d) => d.verdict === "short").length;
  const whatIfs = data.whatIfs.length ? ` ${plural(data.whatIfs.length, "draft")} shown as what-ifs, ${shortDrafts} short.` : "";
  return `Projected State allowance to ${clock.when(data.horizon)}: ${formatDollars(data.nowCents)} now, ${low}, ${formatDollars(data.endCents)} at the end. ${plural(signings, "confirmed signing")}.${whatIfs}`;
}

type ChartProps = {
  /** From `outlookChartData`, on the server. */
  data: OutlookChartData;
  /** The instant the outlook was projected for (the line starts there). */
  now: Date;
  className?: string;
};

/**
 * The chart in `viewerZone` (null: not known yet, so UK time, labelled). With what-ifs in `data`, each draft is a
 * dashed drop at its signing time, plus where a Short one would fit.
 */
export function OutlookFigure({ data, now, className, viewerZone }: ChartProps & { viewerZone: string | null }) {
  const clock = clockFor(viewerZone);
  const plot = { data, now, clock, summary: chartSummary(data, now, clock) };
  const { points } = data;
  const drafts = data.whatIfs.length > 0;
  const zoneName = clock.own ? `your time (${clock.timeZone})` : "UK time";

  return (
    <figure className={cn("space-y-2", className)}>
      <Plot {...plot} variant={COMPACT} className="mx-auto block max-w-md sm:hidden" />
      <Plot {...plot} variant={WIDE} className="hidden sm:block" />
      <figcaption className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <svg viewBox="0 0 14 4" className="h-1 w-3.5" aria-hidden>
            <line x1="0" x2="14" y1="2" y2="2" className="stroke-chart-1" strokeWidth={3} />
          </svg>
          Projected: repayments step it up, confirmed signings drop it
        </span>
        {drafts ? (
          <span className="inline-flex items-center gap-1.5">
            <svg viewBox="0 0 14 4" className="h-1 w-3.5" aria-hidden>
              <line x1="0" x2="14" y1="2" y2="2" className="stroke-muted-foreground" strokeWidth={3} strokeDasharray="4 2" />
            </svg>
            Draft, as a what-if (not counted)
          </span>
        ) : null}
        <span>Chart times are {zoneName}. Point at a step to see what it is.</span>
        <ChartTable
          headers={["", clock.own ? "When (your time)" : "When (UK time)", "Change", "Balance after"]}
          rows={[
            ["Now", clock.time(now), "", formatDollars(data.nowCents)],
            ...points.map((p) => [p.what, clock.time(p.at), signedMoney(p.deltaCents), formatDollars(p.balanceCents)]),
          ]}
        />
      </figcaption>
    </figure>
  );
}

/** The chart in the viewer's own time zone, once it is known (after hydration). */
export function AllowanceOutlookChart(props: ChartProps) {
  return <OutlookFigure {...props} viewerZone={useTimeZone()} />;
}
