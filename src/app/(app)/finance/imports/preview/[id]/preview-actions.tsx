"use client";

import { formatCount } from "@/lib/format";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { commitImportAction, discardImportAction } from "../../actions";

export function PreviewActions({ stagingId, disabled }: { stagingId: string; disabled: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <>
      <Button
        variant="outline"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            await discardImportAction(stagingId);
            router.push("/finance/imports");
          })
        }
      >
        Discard
      </Button>
      <Button
        disabled={pending || disabled}
        onClick={() =>
          startTransition(async () => {
            const result = await commitImportAction(stagingId);
            if (!result.ok) {
              toast.error(result.error);
              return;
            }
            toast.success(`Imported ${formatCount(result.data.newRows)} transactions.`);
            router.push(`/finance/imports/${result.data.batchId}`);
          })
        }
      >
        {pending ? <Spinner /> : null}
        {disabled ? "Nothing new to import" : pending ? "Posting…" : "Confirm import"}
      </Button>
    </>
  );
}
