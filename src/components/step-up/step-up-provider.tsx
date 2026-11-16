"use client";

import { REGEXP_ONLY_DIGITS } from "input-otp";
import { ShieldCheck } from "lucide-react";
import { createContext, useCallback, useContext, useRef, useState, useTransition } from "react";
import { stepUpAction } from "@/app/(app)/actions/step-up";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FieldError } from "@/components/ui/field";
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from "@/components/ui/input-otp";
import { Spinner } from "@/components/ui/spinner";
import { STEP_UP_REQUIRED } from "@/lib/step-up";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };
type WithStepUp = <T>(run: () => Promise<Result<T>>) => Promise<Result<T>>;

const StepUpContext = createContext<WithStepUp | null>(null);

/**
 * Sensitive actions (ADR 0002) answer STEP_UP_REQUIRED until the user has
 * entered a fresh authenticator code. `withStepUp(run)` runs the action, and
 * if it's refused for that reason asks for the code and runs it once more.
 */
export function StepUpProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const waiter = useRef<((ok: boolean) => void) | null>(null);

  const ask = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        waiter.current = resolve;
        setCode("");
        setError(null);
        setOpen(true);
      }),
    [],
  );

  const finish = (ok: boolean) => {
    setOpen(false);
    waiter.current?.(ok);
    waiter.current = null;
  };

  const withStepUp: WithStepUp = useCallback(
    async (run) => {
      const first = await run();
      if (first.ok || first.error !== STEP_UP_REQUIRED) return first;
      if (!(await ask())) return { ok: false, error: "Cancelled. Confirm with your authenticator to continue." };
      return run();
    },
    [ask],
  );

  function submit(value: string) {
    setError(null);
    startTransition(async () => {
      const result = await stepUpAction(value);
      if (!result.ok) {
        setError(result.error);
        setCode("");
        return;
      }
      finish(true);
    });
  }

  return (
    <StepUpContext.Provider value={withStepUp}>
      {children}
      <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : finish(false))}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheck className="size-5 text-primary" aria-hidden /> Confirm it&rsquo;s you
            </DialogTitle>
            <DialogDescription>
              Enter the code from your authenticator app. This unlocks sensitive actions for 5 minutes.
            </DialogDescription>
          </DialogHeader>
          <form method="post"
            noValidate
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              submit(code);
            }}
          >
            <InputOTP
              maxLength={6}
              pattern={REGEXP_ONLY_DIGITS}
              value={code}
              onChange={setCode}
              onComplete={submit}
              autoFocus
              autoComplete="one-time-code"
              inputMode="numeric"
              disabled={pending}
              aria-label="Authentication code"
              aria-invalid={error ? true : undefined}
              containerClassName="justify-center"
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
            {pending ? (
              <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                <Spinner /> Checking…
              </p>
            ) : null}
            {error && !pending ? <FieldError className="text-center">{error}</FieldError> : null}
          </form>
        </DialogContent>
      </Dialog>
    </StepUpContext.Provider>
  );
}

export function useStepUp(): WithStepUp {
  const ctx = useContext(StepUpContext);
  if (!ctx) throw new Error("useStepUp must be used inside <StepUpProvider>");
  return ctx;
}
