"use client";

import { useNow } from "@/hooks/use-now";
import { shortMonths } from "@/lib/dates";

/**
 * Renders an instant in the viewer's own timezone (ADR 0001). The server has no
 * idea of the browser's zone, so the first paint shows UTC and the client
 * re-renders in local time after hydration. Hovering shows the exact UTC value.
 */
type Format = "datetime" | "date" | "relative";

function formatAbsolute(date: Date, format: Exclude<Format, "relative">, timeZone?: string) {
  const text = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "numeric",
    month: "short",
    year: "numeric",
    ...(format === "datetime" ? { hour: "2-digit", minute: "2-digit" } : {}),
  }).format(date);
  return shortMonths(text);
}

function formatRelative(date: Date, now: number) {
  const seconds = Math.round((date.getTime() - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat("en-GB", { numeric: "auto" });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["week", 604_800],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.trunc(seconds / size), unit);
  }
  return "just now";
}

export function LocalTime({ value, format = "datetime" }: { value: string | Date | null; format?: Format }) {
  const now = useNow(); // null until hydrated
  if (!value) return <span className="text-muted-foreground">—</span>;
  const date = typeof value === "string" ? new Date(value) : value;
  const utc = `${date.toISOString().replace("T", " ").slice(0, 19)} UTC`;

  const text =
    now === null
      ? formatAbsolute(date, format === "relative" ? "datetime" : format, "UTC")
      : format === "relative"
        ? formatRelative(date, now)
        : formatAbsolute(date, format);

  return (
    <time dateTime={date.toISOString()} title={utc} className="num whitespace-nowrap">
      {text}
    </time>
  );
}
