import { ShieldCheck } from "lucide-react";
import { LogoMark, Wordmark } from "@/components/brand/logo";

export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="grid min-h-svh lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <main className="flex flex-col px-6 py-8 sm:px-10">
        {/* On wide screens the brand panel carries the wordmark; one logo per screen is enough. */}
        <div className="flex items-center gap-2.5 lg:invisible">
          <LogoMark />
          <Wordmark className="text-lg" />
        </div>
        <div className="flex flex-1 items-center justify-center py-10">
          <div className="w-full max-w-sm">{children}</div>
        </div>
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <ShieldCheck className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>
            Authorised Litt&rsquo;s Loans staff only. Sign-ins and all activity are recorded in a tamper-evident audit
            log.
          </span>
        </p>
      </main>

      <aside
        aria-label="About Litt’s Loans"
        className="relative hidden overflow-hidden bg-[#2A2D2B] text-[#ECEDE8] lg:flex lg:flex-col lg:justify-between lg:p-12"
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.07]"
          style={{
            backgroundImage:
              "repeating-linear-gradient(135deg, #75ACA8 0 1px, transparent 1px 22px), repeating-linear-gradient(45deg, #75ACA8 0 1px, transparent 1px 22px)",
          }}
        />
        <div aria-hidden className="relative font-display italic leading-[0.85]">
          <div className="text-5xl font-light text-[#B9C2C0]">Litt&rsquo;s</div>
          <div className="text-[7.5rem] font-extrabold tracking-wide text-[#59B280]">LOANS</div>
        </div>
        <div className="relative max-w-md space-y-2">
          <p className="text-2xl leading-tight font-semibold tracking-tight">Staff system</p>
          <p className="text-sm leading-relaxed text-white/65">
            Private loans, mortgages, collections and commission. Figures come from the business wallet&rsquo;s bank
            exports, the phone&rsquo;s loan cards and the tablet&rsquo;s sale agreements.
          </p>
        </div>
      </aside>
    </div>
  );
}
