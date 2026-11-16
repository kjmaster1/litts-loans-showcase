"use client";

import { REGEXP_ONLY_DIGITS } from "input-otp";
import { Check, Copy, Download } from "lucide-react";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from "@/components/ui/input-otp";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth-client";

type Step =
  | { name: "password" }
  | { name: "scan"; qr: string; secret: string; backupCodes: string[] }
  | { name: "backup"; backupCodes: string[] };

function secretFromUri(uri: string): string {
  return new URL(uri).searchParams.get("secret") ?? "";
}

function StepIndicator({ current }: { current: Step["name"] }) {
  const steps: { key: Step["name"]; label: string }[] = [
    { key: "password", label: "Confirm" },
    { key: "scan", label: "Scan" },
    { key: "backup", label: "Save codes" },
  ];
  const index = steps.findIndex((s) => s.key === current);
  return (
    <ol className="flex items-center gap-2 text-xs" aria-label="Setup progress">
      {steps.map((s, i) => (
        <li key={s.key} className="flex items-center gap-2" aria-current={i === index ? "step" : undefined}>
          <span
            className={
              i < index
                ? "flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground"
                : i === index
                  ? "flex size-5 items-center justify-center rounded-full border-2 border-primary font-semibold text-primary"
                  : "flex size-5 items-center justify-center rounded-full border text-muted-foreground"
            }
          >
            {i < index ? <Check className="size-3" aria-hidden /> : i + 1}
          </span>
          <span className={i === index ? "font-medium" : "text-muted-foreground"}>{s.label}</span>
          {i < steps.length - 1 ? <span className="h-px w-6 bg-border" aria-hidden /> : null}
        </li>
      ))}
    </ol>
  );
}

export function EnrollTwoFactor({ username }: { username: string }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>({ name: "password" });
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();

  function startEnrolment(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get("password") ?? "");
    setError(null);
    startTransition(async () => {
      const { data, error: enableError } = await authClient.twoFactor.enable({ password });
      if (enableError || !data || data.method !== "totp") {
        setError(enableError?.status === 429 ? "Too many attempts. Please wait." : "Incorrect password.");
        return;
      }
      const qr = await QRCode.toDataURL(data.totpURI, { margin: 1, width: 192, errorCorrectionLevel: "M" });
      setStep({ name: "scan", qr, secret: secretFromUri(data.totpURI), backupCodes: data.backupCodes });
    });
  }

  function verify(value: string) {
    if (step.name !== "scan") return;
    setError(null);
    startTransition(async () => {
      const { error: verifyError } = await authClient.twoFactor.verifyTotp({ code: value });
      if (verifyError) {
        // A rate-limited attempt isn't a wrong code (5 a minute; QA 2026-10-11).
        setError(
          verifyError.status === 429
            ? "Too many attempts. Wait a minute, then enter the newest code."
            : "That code didn't match. Make sure your device's clock is correct and try the newest code.",
        );
        setCode("");
        return;
      }
      setStep({ name: "backup", backupCodes: step.backupCodes });
    });
  }

  if (step.name === "password") {
    return (
      <div className="space-y-6">
        <StepIndicator current="password" />
        <form method="post" onSubmit={startEnrolment} noValidate>
          <FieldGroup>
            {/* For password managers: the account this password belongs to. */}
            <input type="text" name="username" autoComplete="username" value={username} readOnly hidden />
            <Field>
              <FieldLabel htmlFor="password">Confirm your password</FieldLabel>
              <Input id="password" name="password" type="password" autoComplete="current-password" autoFocus required />
            </Field>
            {error ? <FieldError>{error}</FieldError> : null}
            <Button type="submit" size="lg" className="w-full" disabled={pending}>
              {pending ? <Spinner /> : null}
              Continue
            </Button>
          </FieldGroup>
        </form>
      </div>
    );
  }

  if (step.name === "scan") {
    const grouped = step.secret.match(/.{1,4}/g)?.join(" ") ?? step.secret;
    return (
      <div className="space-y-6">
        <StepIndicator current="scan" />
        <div className="flex flex-col items-center gap-4 rounded-xl border bg-card p-5 sm:flex-row sm:items-start">
          {/* eslint-disable-next-line @next/next/no-img-element -- data URL, nothing to optimise */}
          <img src={step.qr} alt="QR code for your authenticator app" width={160} height={160} className="rounded-md bg-white p-1" />
          <div className="space-y-2 text-sm">
            <p>Scan this with your authenticator app.</p>
            <p className="text-muted-foreground">Can&rsquo;t scan? Enter this key manually:</p>
            <code className="ident block rounded-md bg-muted px-2 py-1.5 break-all select-all">{grouped}</code>
            <p className="text-xs text-muted-foreground">Account: {username}</p>
          </div>
        </div>
        <form method="post"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            verify(code);
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="code">Enter the 6-digit code it shows</FieldLabel>
              <InputOTP
                id="code"
                maxLength={6}
                pattern={REGEXP_ONLY_DIGITS}
                value={code}
                onChange={setCode}
                onComplete={verify}
                autoFocus
                inputMode="numeric"
                autoComplete="one-time-code"
                disabled={pending}
              >
                <InputOTPGroup>
                  <InputOTPSlot index={0} />
                  <InputOTPSlot index={1} />
                  <InputOTPSlot index={2} />
                </InputOTPGroup>
                <InputOTPSeparator />
                <InputOTPGroup>
                  <InputOTPSlot index={3} />
                  <InputOTPSlot index={4} />
                  <InputOTPSlot index={5} />
                </InputOTPGroup>
              </InputOTP>
            </Field>
            {error ? <FieldError>{error}</FieldError> : null}
            <Button type="submit" size="lg" className="w-full" disabled={pending || code.length < 6}>
              {pending ? <Spinner /> : null}
              Verify and turn on
            </Button>
          </FieldGroup>
        </form>
      </div>
    );
  }

  const text = step.backupCodes.join("\n");
  return (
    <div className="space-y-6">
      <StepIndicator current="backup" />
      <div className="space-y-2">
        <h2 className="font-medium">Save your backup codes</h2>
        <p className="text-sm text-muted-foreground">
          If you lose your phone, each of these codes lets you sign in once. Store them in a password manager. They
          won&rsquo;t be shown again.
        </p>
      </div>
      <ul className="grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-xl border bg-card p-4" aria-label="Backup codes">
        {step.backupCodes.map((c) => (
          <li key={c} className="ident">
            {c}
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={async () => {
            await navigator.clipboard.writeText(text);
            setCopied(true);
          }}
        >
          {copied ? <Check /> : <Copy />}
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            const url = URL.createObjectURL(new Blob([`Litt's Loans backup codes (${username})\n\n${text}\n`], { type: "text/plain" }));
            const a = Object.assign(document.createElement("a"), { href: url, download: "litts-loans-backup-codes.txt" });
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          <Download />
          Download
        </Button>
      </div>
      <Field orientation="horizontal">
        <input
          id="saved"
          type="checkbox"
          checked={saved}
          onChange={(e) => setSaved(e.target.checked)}
          className="size-4 accent-[var(--primary)]"
        />
        <FieldLabel htmlFor="saved" className="font-normal">
          I&rsquo;ve stored these codes somewhere safe
        </FieldLabel>
      </Field>
      <FieldDescription className="sr-only">Required before continuing.</FieldDescription>
      <Button
        size="lg"
        className="w-full"
        disabled={!saved}
        onClick={() => {
          router.push("/");
          router.refresh();
        }}
      >
        Go to dashboard
      </Button>
    </div>
  );
}
