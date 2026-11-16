"use client";

import { FileSpreadsheet, Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { uploadExportAction } from "./actions";

const MAX_BYTES = 3_500_000;

/** Drag-and-drop (or click) upload of the bank's .xlsx export. */
export function UploadForm() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function pick(f: File | undefined) {
    setError(null);
    if (!f) return;
    if (!f.name.toLowerCase().endsWith(".xlsx")) return setError("That isn't an .xlsx file.");
    if (f.size > MAX_BYTES) return setError("That file is larger than 3.5 MB.");
    setFile(f);
  }

  function submit() {
    if (!file) return;
    const data = new FormData();
    data.set("file", file);
    startTransition(async () => {
      const result = await uploadExportAction(data);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push(`/finance/imports/preview/${result.data.stagingId}`);
    });
  }

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          pick(e.dataTransfer.files[0]);
        }}
        className={cn(
          "flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
          dragging ? "border-primary bg-primary/5" : "border-border bg-card hover:bg-muted/50",
        )}
      >
        {file ? <FileSpreadsheet className="size-8 text-primary" aria-hidden /> : <Upload className="size-8 text-muted-foreground" aria-hidden />}
        <span className="font-medium">{file ? file.name : "Drop the bank export here, or click to choose"}</span>
        <span className="text-sm text-muted-foreground">
          {file ? `${(file.size / 1024).toFixed(0)} KB · ready to check` : ".xlsx from the in-game bank · any date range · max 3.5 MB"}
        </span>
      </button>
      <input
        ref={input}
        type="file"
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        className="sr-only"
        aria-label="Bank export file"
        onChange={(e) => pick(e.target.files?.[0])}
      />
      {error ? <FieldError>{error}</FieldError> : null}
      <div className="flex items-center gap-3">
        <Button onClick={submit} disabled={!file || pending}>
          {pending ? <Spinner /> : null}
          {pending ? "Checking file…" : "Check file"}
        </Button>
        <p className="text-xs text-muted-foreground">Nothing is saved until you review and confirm.</p>
      </div>
    </div>
  );
}
