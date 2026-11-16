import { CircleAlert, CircleCheck, Hash, Sparkles, UserCheck } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CATEGORIES, type Category } from "@/domain/ledger/categories";
import { cn } from "@/lib/utils";

export type ConfidenceLevel = "certain" | "tag" | "heuristic" | "unclassified" | "manual";

const CONFIDENCE: Record<ConfidenceLevel, { icon: typeof CircleCheck; label: string; className: string }> = {
  certain: { icon: CircleCheck, label: "Game-generated, classified with certainty", className: "text-success" },
  tag: { icon: Hash, label: "Classified from a comment tag", className: "text-info" },
  heuristic: { icon: Sparkles, label: "Suggested from the comment wording; check if unsure", className: "text-warning" },
  manual: { icon: UserCheck, label: "Classified by a person", className: "text-info" },
  unclassified: { icon: CircleAlert, label: "Needs review", className: "text-danger" },
};

/** Category label with an icon showing how it was decided (never colour alone). */
export function CategoryBadge({ category, confidence, className }: { category: string; confidence: ConfidenceLevel; className?: string }) {
  const c = CONFIDENCE[confidence];
  const label = CATEGORIES[category as Category]?.label ?? category;
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-sm", className)}>
      <Tooltip>
        <TooltipTrigger
          render={<span className={cn("inline-flex", c.className)} aria-label={c.label} role="img" />}
        >
          <c.icon className="size-3.5" aria-hidden />
        </TooltipTrigger>
        <TooltipContent>{c.label}</TooltipContent>
      </Tooltip>
      <span className={confidence === "unclassified" ? "font-medium text-danger" : undefined}>{label}</span>
    </span>
  );
}

export const CONFIDENCE_LEGEND = CONFIDENCE;
