"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { reclassifyAction } from "../actions";

type Option = { value: string; label: string; group: string };

export function ReclassifyForm({ transactionId, options, current }: { transactionId: string; options: Option[]; current: string }) {
  const router = useRouter();
  const [category, setCategory] = useState<string>("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const groups = [...new Set(options.map((o) => o.group))];

  return (
    <form method="post"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        startTransition(async () => {
          const result = await reclassifyAction({ transactionId, category, reason });
          if (!result.ok) {
            setError(result.error);
            return;
          }
          toast.success("Reclassified. The original posting was reversed and a new one made.");
          setReason("");
          setCategory("");
          router.refresh();
        });
      }}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="category">New category</FieldLabel>
          <Select value={category} onValueChange={(v) => setCategory(String(v))} items={options.map((o) => ({ value: o.value, label: o.label }))}>
            <SelectTrigger id="category" className="w-full">
              <SelectValue placeholder="Choose a category" />
            </SelectTrigger>
            <SelectContent>
              {groups.map((g) => (
                <SelectGroup key={g}>
                  <SelectLabel>{g}</SelectLabel>
                  {options
                    .filter((o) => o.group === g)
                    .map((o) => (
                      <SelectItem key={o.value} value={o.value} disabled={o.value === current}>
                        {o.label}
                      </SelectItem>
                    ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="reason">Reason</FieldLabel>
          <Textarea id="reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="e.g. Sale of repossessed Bison from loan #18" />
          <FieldDescription>Recorded in the audit log and on the journal entries.</FieldDescription>
        </Field>
        {error ? <FieldError>{error}</FieldError> : null}
        <div>
          <Button type="submit" disabled={pending || !category || reason.trim().length < 5}>
            {pending ? <Spinner /> : null}
            Reclassify
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}
