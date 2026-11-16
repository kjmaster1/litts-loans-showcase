import { LocalTime } from "@/components/data/local-time";
import type { Freshness } from "@/server/freshness";

/** "Bank export to … · phone cards pasted …": which hand-fed data a page rests on, and how old it is. */
export function DataAsOf({ freshness, sources }: { freshness: Freshness; sources: ("bank" | "cards" | "tablet")[] }) {
  const parts = sources.map((s) => {
    if (s === "bank")
      return (
        <span key={s}>
          Bank export {freshness.bankTo ? <>to <LocalTime value={freshness.bankTo} /></> : "not imported yet"}
        </span>
      );
    if (s === "cards")
      return (
        <span key={s}>
          phone cards {freshness.cardsAt ? <>pasted <LocalTime value={freshness.cardsAt} format="relative" /></> : "not pasted yet"}
        </span>
      );
    return (
      <span key={s}>
        tablet {freshness.tabletAt ? <>pasted <LocalTime value={freshness.tabletAt} format="relative" /></> : "not pasted yet"}
      </span>
    );
  });
  return (
    <p className="text-caption">
      Data as of:{" "}
      {parts.map((p, i) => (
        <span key={i}>
          {i ? " · " : ""}
          {p}
        </span>
      ))}
    </p>
  );
}
