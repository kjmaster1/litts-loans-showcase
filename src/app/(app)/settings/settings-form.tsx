"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { useStepUp } from "@/components/step-up/step-up-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { settingsSchema, type Settings } from "@/domain/settings";
import { friendlyIssue } from "@/lib/validation-messages";
import { cn } from "@/lib/utils";
import { saveSettingsAction } from "./actions";

type Group = keyof Settings;
type Unit = "%" | "days" | "hours" | "$";
/** One setting, a from–to pair shown on one line, or a federal band (its end in $, then two maximums in %). */
type Row =
  | { group: Group; key: string; label: string; unit: Unit; hint?: string }
  | { group: Group; range: [string, string]; label: string; unit: Unit; hint?: string }
  | { group: Group; band: { upTo: string | null; fee: string; broker: string }; label: string; unit: "%"; hint?: string };

const federalBand = (n: 1 | 2 | 3 | 4, label: string): Row => ({
  group: "mortgages",
  band: { upTo: n < 4 ? `federalBand${n}UpToDollars` : null, fee: `federalBand${n}BankerFeeMaxPct`, broker: `federalBand${n}BrokerRateMaxPct` },
  label,
  unit: "%",
});

const SECTIONS: { title: string; description: string; rows: Row[] }[] = [
  {
    title: "Commission",
    description: "Weeks not yet closed use these rates; closed weeks keep the rates they were closed with.",
    rows: [
      { group: "commission", key: "loanInterestPct", label: "Loan interest to the loan’s officer", unit: "%", hint: "Of interest received, after tax." },
      { group: "commission", key: "mortgageOriginatorPct", label: "Banker fee to the officer who arranged it", unit: "%" },
      { group: "commission", key: "mortgagePoolPct", label: "Banker fee to the weekly staff pool", unit: "%", hint: "Shared equally; the company keeps the rest of the fee." },
    ],
  },
  {
    title: "Loans",
    description: "Handbook §4B, new-loan checks and contract terms. Warnings only: officers can still issue a contract.",
    rows: [
      { group: "loans", range: ["rateMinPct", "rateMaxPct"], label: "Interest rate range", unit: "%", hint: "Outside it, a new loan is warned to get Executive Management’s agreement (not blocked)." },
      { group: "loans", key: "stateRatePct", label: "State rate to enter in game", unit: "%", hint: "Comes off the principal Litt’s gets back." },
      { group: "loans", key: "maxPaymentToIncomePct", label: "Weekly payment at most", unit: "%", hint: "Of the borrower’s stated weekly income." },
      { group: "loans", key: "defaultFeePerDayPct", label: "Defaulted Account Fee to suggest", unit: "%", hint: "Of the loan, per day; the officer chooses." },
      { group: "loans", key: "writeOffAfterDays", label: "Write-off available after", unit: "days", hint: "Counted from when the loan defaulted." },
      { group: "loans", key: "purchaseDays", label: "Contract: buy the vehicle or property within", unit: "days" },
      { group: "loans", key: "detailsHours", label: "Contract: send its details within", unit: "hours" },
      { group: "loans", key: "extraHours", label: "Contract: then return the money within", unit: "hours" },
      { group: "loans", key: "defaultAfterDays", label: "Contract: default when a payment is late by", unit: "days" },
    ],
  },
  {
    title: "Federal mortgage maximums",
    description:
      "State-funded mortgages arranged from 15 Oct 2026. The band is set by down payment + loan, and the whole mortgage uses its band’s maximums. A quote over them can’t be saved; a tablet agreement over them is flagged as a breach.",
    rows: [federalBand(1, "Band 1"), federalBand(2, "Band 2"), federalBand(3, "Band 3"), federalBand(4, "Band 4: above band 3")],
  },
  {
    title: "Large mortgages",
    description:
      "Mortgages arranged from 15 Oct 2026, State- or company-funded. Above this, an executive (Owner, CEO or COO) approves the quote before it goes on the tablet; a tablet agreement nobody approved is flagged and the executives are notified. A quote that leaves the State allowance below the cushion is Tight.",
    rows: [
      { group: "mortgages", key: "executiveApprovalAboveDollars", label: "Executive approval above", unit: "$", hint: "Down payment + loan." },
      { group: "mortgages", key: "allowanceCushionDollars", label: "State allowance cushion", unit: "$", hint: "A quote that fits but leaves less than this counts as Tight." },
    ],
  },
  {
    title: "Mortgage guidelines",
    description: "Handbook §4A. Flags on quotes, mortgages and tablet pastes; they don’t block.",
    rows: [
      { group: "mortgages", key: "brokerRateStartPct", label: "Broker rate: start negotiations at", unit: "%" },
      { group: "mortgages", key: "fedRateMinPct", label: "Fed rate: State minimum", unit: "%", hint: "Below this is a breach." },
      { group: "mortgages", key: "fedRateSecondHomeMinPct", label: "Fed rate: any other property", unit: "%" },
      { group: "mortgages", key: "downPaymentMinPct", label: "Down payment minimum", unit: "%", hint: "Of down payment + loan (the tablet’s rule)." },
    ],
  },
  {
    title: "Legal cases",
    description: "What the lawyer is paid for each defaulted loan handed to Legal. Cases already handed over keep the fee they had.",
    rows: [{ group: "legal", key: "caseFeeDollars", label: "Attorney & filing fee per case", unit: "$" }],
  },
];

const keysOf = (r: Row) => ("range" in r ? r.range : "band" in r ? [r.band.upTo, r.band.fee, r.band.broker].filter((k): k is string => k !== null) : [r.key]);
const paths = SECTIONS.flatMap((s) => s.rows.flatMap((r) => keysOf(r).map((k) => `${r.group}.${k}`)));
const read = (s: Settings, path: string) => {
  const [g, k] = path.split(".") as [Group, string];
  return (s[g] as Record<string, number>)[k];
};

export function SettingsForm({ current, canEdit }: { current: Settings; canEdit: boolean }) {
  const router = useRouter();
  const withStepUp = useStepUp();
  const initial = () => Object.fromEntries(paths.map((p) => [p, String(read(current, p))]));
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const build = (): Settings => {
    const out = structuredClone(current) as Record<Group, Record<string, number>>;
    for (const [path, v] of Object.entries(values)) {
      const [g, k] = path.split(".") as [Group, string];
      out[g][k] = Number(v);
    }
    return out as unknown as Settings;
  };
  const changed = (path: string) => values[path].trim() === "" || Number(values[path]) !== read(current, path);
  const changes = paths.filter(changed).length;

  const input = (group: Group, key: string, unit: Unit, label: string) => {
    const path = `${group}.${key}`;
    return (
      <Input
        id={`${group}-${key}`}
        aria-label={label}
        type="number"
        inputMode="decimal"
        step={unit === "%" ? 0.1 : 1}
        min={0}
        max={unit === "%" ? 100 : unit === "$" ? 1_000_000_000 : 365}
        value={values[path]}
        disabled={!canEdit || pending}
        onChange={(e) => setValues((v) => ({ ...v, [path]: e.target.value }))}
        className={cn(unit === "$" ? "w-32 text-right" : "w-24 text-right", changed(path) && "border-primary ring-1 ring-primary/30")}
      />
    );
  };
  const was = (keys: string[], group: Group, unit: Unit) => {
    const old = keys.filter((k) => changed(`${group}.${k}`));
    if (!old.length) return null;
    return (
      <span className="text-xs text-primary">
        Was {keys.map((k) => read(current, `${group}.${k}`)).join("–")}
        {unit === "%" ? "%" : unit === "$" ? "" : ` ${unit}`}
      </span>
    );
  };
  // Each label stays with its input, so a narrow screen wraps between the three, not inside one.
  const band = (r: Extract<Row, { band: unknown }>) => {
    const part = (key: string, unit: "$" | "%", text: string) => (
      <span className="inline-flex items-center gap-2 whitespace-nowrap">
        {was([key], r.group, unit)}
        <span className="text-sm text-muted-foreground">{unit === "$" ? `${text} $` : text}</span>
        {input(r.group, key, unit, `${r.label}: ${text}`)}
        {unit === "%" ? <span className="text-sm text-muted-foreground">%</span> : null}
      </span>
    );
    return (
      <>
        {r.band.upTo ? part(r.band.upTo, "$", "up to") : null}
        {part(r.band.fee, "%", "banker fee at most")}
        {part(r.band.broker, "%", "broker rate at most")}
      </>
    );
  };

  return (
    <form
      method="post"
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        // Rules first, so nobody types a code only to be told the numbers don't work.
        const check = settingsSchema.safeParse(build());
        if (!check.success) return setError(friendlyIssue(check.error.issues[0] as never));
        if (reason.trim().length < 5) return setError("Give a reason (at least 5 characters).");
        startTransition(async () => {
          const r = await withStepUp(() => saveSettingsAction({ values: check.data, reason }));
          if (!r.ok) return setError(r.error);
          toast.success("Settings saved.");
          setReason("");
          router.refresh();
        });
      }}
    >
      {SECTIONS.map((s) => (
        <Card key={s.title}>
          <CardHeader>
            <CardTitle>{s.title}</CardTitle>
            <CardDescription>{s.description}</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            <div className="divide-y border-t">
              {s.rows.map((r) => {
                const keys = keysOf(r);
                const id = `${r.group}-${keys[0]}`;
                return (
                  <div key={id} className={cn("grid items-center gap-x-6 gap-y-2 px-6 py-3", "band" in r ? "" : "sm:grid-cols-[minmax(0,1fr)_auto]")}>
                    <div className="min-w-0">
                      <label htmlFor={id} className="text-sm font-medium">
                        {r.label}
                      </label>
                      {r.hint ? <p className="text-xs text-muted-foreground">{r.hint}</p> : null}
                    </div>
                    <div className={cn("flex flex-wrap items-center gap-2", "band" in r ? "gap-x-5" : "sm:justify-end")}>
                      {"band" in r ? null : was(keys, r.group, r.unit)}
                      {"band" in r ? (
                        band(r)
                      ) : "range" in r ? (
                        <>
                          {input(r.group, r.range[0], r.unit, `${r.label} from`)}
                          <span className="text-sm text-muted-foreground">to</span>
                          {input(r.group, r.range[1], r.unit, `${r.label} to`)}
                        </>
                      ) : (
                        <>
                          {r.unit === "$" ? <span className="text-sm text-muted-foreground">$</span> : null}
                          {input(r.group, r.key, r.unit, r.label)}
                        </>
                      )}
                      {"band" in r ? null : <span className="w-10 text-sm text-muted-foreground">{r.unit === "$" ? "" : r.unit}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      ))}
      {canEdit ? (
        // Sticks to the bottom of the screen while there are unsaved changes.
        <div className={cn("bottom-0 z-20 -mx-1 rounded-xl border bg-card p-4 shadow-lg", changes > 0 ? "sticky" : "")}>
          <div className="flex flex-wrap items-end gap-3">
            <Field className="min-w-60 flex-1">
              <FieldLabel htmlFor="settings-reason">
                {changes > 0 ? `${changes} unsaved change${changes === 1 ? "" : "s"}` : "No changes yet"}
                {changes > 0 ? ": reason" : ""}
              </FieldLabel>
              <Input
                id="settings-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. Pool raised to 35% from this week (owner)"
                disabled={pending || changes === 0}
              />
            </Field>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="ghost"
                disabled={pending || changes === 0}
                onClick={() => {
                  setValues(initial());
                  setReason("");
                  setError(null);
                }}
              >
                Discard
              </Button>
              <Button type="submit" disabled={pending || changes === 0 || reason.trim().length < 5}>
                {pending ? <Spinner /> : null}
                Save settings
              </Button>
            </div>
          </div>
          <FieldDescription className="mt-2">Applies from now and is kept in the history. You&rsquo;ll be asked for your authenticator code.</FieldDescription>
          {error ? (
            <FieldError role="alert" className="mt-2">
              {error}
            </FieldError>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
