"use client";

import { Download } from "lucide-react";
import { useState, useTransition } from "react";
import { useStepUp } from "@/components/step-up/step-up-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldError } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { prepareExportAction } from "./actions";

/** Backups and the full data export (research/11). */
export function DataCard({ canExport }: { canExport: boolean }) {
  const withStepUp = useStepUp();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Backups</CardTitle>
        <CardDescription>
          An encrypted copy of the whole database is saved to the private GitHub repository every night and kept for 30 days. The hosting
          provider on its own can only undo the last 6 hours.
        </CardDescription>
      </CardHeader>
      {canExport ? (
        <CardContent className="space-y-2">
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => {
              setError(null);
              startTransition(async () => {
                const r = await withStepUp(() => prepareExportAction());
                if (!r.ok) return setError(r.error);
                // A file download (route handler), not a page — so a link click, not the router.
                const link = document.createElement("a");
                link.href = "/settings/export";
                link.click();
              });
            }}
          >
            {pending ? <Spinner /> : <Download />}
            Download everything (Excel)
          </Button>
          <p className="text-xs text-muted-foreground">
            Every loan, mortgage, bank row, ledger entry, commission and audit record, one sheet each. No passwords or sign-in secrets. Keep it
            somewhere private; the download is recorded in the audit log.
          </p>
          {error ? <FieldError>{error}</FieldError> : null}
        </CardContent>
      ) : null}
    </Card>
  );
}
