import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";

/** "Excel" download for a list page; `href` carries the page's current filters. */
export function ExportButton({ href }: { href: string }) {
  return (
    <Button variant="outline" render={<a href={href} download />}>
      <Download aria-hidden /> Excel
    </Button>
  );
}

/** Query string of the non-empty values. */
export function exportHref(path: string, params: Record<string, string | undefined>): string {
  const qs = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => Boolean(e[1]))).toString();
  return qs ? `${path}?${qs}` : path;
}
