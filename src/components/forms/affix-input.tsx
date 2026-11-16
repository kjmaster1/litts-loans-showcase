"use client";

import { formatCount } from "@/lib/format";
import { useState } from "react";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group";
import { cn } from "@/lib/utils";

/**
 * A number field with its unit beside it ("$" before money, "%" or "weeks" after) — the
 * unit is part of the field, not its label. Money shows thousands separators once the
 * field is left (typing stays plain, so the caret never jumps). Text input, not
 * type=number: no spinners, no scroll-wheel changes, and pasted "$12,500" still works.
 */
export function AffixInput({
  id,
  value,
  onChange,
  prefix,
  suffix,
  money = false,
  decimals = false,
  className,
  ...rest
}: {
  id: string;
  value: string;
  onChange: (raw: string) => void;
  prefix?: string;
  suffix?: string;
  /** Group thousands when not editing. */
  money?: boolean;
  /** Allow a decimal point (rates). */
  decimals?: boolean;
  className?: string;
} & Omit<React.ComponentProps<"input">, "id" | "value" | "onChange" | "prefix">) {
  const [focused, setFocused] = useState(false);
  const n = Number(value.replace(/,/g, ""));
  const shown = money && !focused && value.trim() && Number.isFinite(n) ? formatCount(n) : value;
  return (
    <InputGroup className={cn("h-8", className)}>
      {prefix ? (
        <InputGroupAddon>
          <InputGroupText>{prefix}</InputGroupText>
        </InputGroupAddon>
      ) : null}
      <InputGroupInput
        id={id}
        inputMode={decimals ? "decimal" : "numeric"}
        autoComplete="off"
        value={shown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => onChange(e.target.value.replace(decimals ? /[^\d.]/g : /[^\d]/g, ""))}
        className="num"
        {...rest}
      />
      {suffix ? (
        <InputGroupAddon align="inline-end">
          <InputGroupText>{suffix}</InputGroupText>
        </InputGroupAddon>
      ) : null}
    </InputGroup>
  );
}
