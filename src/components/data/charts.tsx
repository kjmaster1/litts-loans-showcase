import { formatDollars } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Small charts (redesign 2026-10), drawn as server-rendered SVG: no chart library,
 * no client JavaScript, nothing the strict CSP has to allow. Each is an image with
 * a written summary for screen readers, plus the numbers in a table on request.
 * Colours are theme tokens, so they follow light/dark mode.
 */

const fmtMoney = formatDollars;
/** Axis money: "$2.5m", "$40k", "$900". */
export const compact = (cents: number) => {
  const d = cents / 100;
  if (Math.abs(d) >= 1_000_000) return `$${(d / 1_000_000).toFixed(d >= 10_000_000 ? 0 : 1)}m`;
  if (Math.abs(d) >= 1_000) return `$${Math.round(d / 1_000)}k`;
  return `$${Math.round(d)}`;
};

/** Up to ~5 round gridline values covering 0..max. */
function ticks(max: number): number[] {
  if (max <= 0) return [0];
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  return Array.from({ length: Math.ceil(max / step) + 1 }, (_, i) => i * step);
}

export type BarDatum = { label: string; /** cents per series, in `series` order */ values: number[]; highlight?: boolean };

/** Stacked bars, e.g. money expected per week split into loans and mortgages. */
export function StackedBarChart({
  data,
  series,
  summary,
  height = 180,
  className,
}: {
  data: BarDatum[];
  series: { name: string; className: string }[];
  summary: string;
  height?: number;
  className?: string;
}) {
  const W = 640;
  const H = height;
  const pad = { l: 44, r: 8, t: 8, b: 24 };
  const totals = data.map((d) => d.values.reduce((s, v) => s + v, 0));
  const yt = ticks(Math.max(...totals, 1));
  const top = yt[yt.length - 1] || 1;
  const bw = (W - pad.l - pad.r) / data.length;
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / top);
  return (
    <figure className={cn("space-y-2", className)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary} className="h-auto w-full overflow-visible">
        {yt.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="stroke-border" strokeWidth={1} />
            <text x={pad.l - 6} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[10px]">
              {compact(t)}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          let acc = 0;
          const x = pad.l + i * bw + bw * 0.18;
          const w = bw * 0.64;
          return (
            <g key={d.label}>
              <title>{`${d.label}: ${fmtMoney(totals[i])}`}</title>
              {d.values.map((v, s) => {
                const y0 = y(acc);
                acc += v;
                const y1 = y(acc);
                return v > 0 ? <rect key={s} x={x} y={y1} width={w} height={Math.max(0, y0 - y1)} rx={2} className={series[s].className} /> : null;
              })}
              <text x={x + w / 2} y={H - 6} textAnchor="middle" className={cn("text-[10px]", d.highlight ? "fill-foreground font-semibold" : "fill-muted-foreground")}>
                {d.label}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {series.map((s) => (
          <span key={s.name} className="inline-flex items-center gap-1.5">
            <svg viewBox="0 0 10 10" className="size-2.5" aria-hidden>
              <rect width="10" height="10" rx="2" className={s.className} />
            </svg>
            {s.name}
          </span>
        ))}
        <ChartTable
          headers={["", ...series.map((s) => s.name), "Total"]}
          rows={data.map((d, i) => [d.label, ...d.values.map(fmtMoney), fmtMoney(totals[i])])}
        />
      </figcaption>
    </figure>
  );
}

export type LinePoint = { label: string; value: number };

/** A line with a soft area under it, e.g. the cash balance day by day. */
export function AreaChart({ points, summary, height = 180, className }: { points: LinePoint[]; summary: string; height?: number; className?: string }) {
  const W = 640;
  const H = height;
  const pad = { l: 44, r: 8, t: 8, b: 24 };
  const values = points.map((p) => p.value);
  const lo = Math.min(0, ...values);
  const yt = ticks(Math.max(...values, 1) - lo).map((t) => t + lo);
  const top = yt[yt.length - 1] || 1;
  const x = (i: number) => pad.l + ((W - pad.l - pad.r) * i) / Math.max(1, points.length - 1);
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - (v - lo) / (top - lo || 1));
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join("");
  const area = `${line}L${x(points.length - 1).toFixed(1)},${y(lo).toFixed(1)}L${x(0).toFixed(1)},${y(lo).toFixed(1)}Z`;
  // About five date labels along the bottom.
  const every = Math.max(1, Math.ceil(points.length / 5));
  const last = points[points.length - 1];
  return (
    <figure className={cn("space-y-2", className)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary} className="h-auto w-full overflow-visible">
        {yt.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="stroke-border" strokeWidth={1} />
            <text x={pad.l - 6} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[10px]">
              {compact(t)}
            </text>
          </g>
        ))}
        {points.length > 1 ? (
          <>
            <path d={area} className="fill-chart-1/12" />
            <path d={line} className="fill-none stroke-chart-1" strokeWidth={2} strokeLinejoin="round" />
            <circle cx={x(points.length - 1)} cy={y(last.value)} r={3.5} className="fill-chart-1" />
          </>
        ) : null}
        {points.map((p, i) =>
          i % every === 0 || i === points.length - 1 ? (
            <text key={p.label} x={x(i)} y={H - 6} textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"} className="fill-muted-foreground text-[10px]">
              {p.label}
            </text>
          ) : null,
        )}
      </svg>
      <figcaption className="text-xs text-muted-foreground">
        <ChartTable headers={["Day", "Balance"]} rows={points.map((p) => [p.label, fmtMoney(p.value)])} />
      </figcaption>
    </figure>
  );
}

/** The chart's numbers, for anyone who'd rather read them (and for screen readers). */
export function ChartTable({ headers, rows }: { headers: string[]; rows: React.ReactNode[][] }) {
  return (
    <details className="ml-auto">
      <summary className="cursor-pointer rounded-sm hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">Show as table</summary>
      <div className="mt-2 max-h-60 overflow-auto rounded-md border">
        <table className="w-full text-xs">
          <thead className="bg-muted/40">
            <tr>
              {headers.map((h, i) => (
                <th key={i} scope="col" className={cn("px-2 py-1 font-medium", i ? "text-right" : "text-left")}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t">
                {r.map((c, j) =>
                  j === 0 ? (
                    <th key={j} scope="row" className="px-2 py-1 text-left font-normal">
                      {c}
                    </th>
                  ) : (
                    <td key={j} className="num px-2 py-1 text-right">
                      {c}
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
