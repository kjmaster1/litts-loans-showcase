import { cn } from "@/lib/utils";

/**
 * Brand mark: a stack of banknotes with a cream band, simplified from the
 * Litt's Loans logo (reference/brand/litts-loans-logo.png) so it reads at 16px.
 */
export function LogoMark({ className, title }: { className?: string; title?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={cn("size-8 shrink-0", className)}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      <rect width="32" height="32" rx="7" fill="#505050" />
      <rect x="6" y="15" width="20" height="10" rx="2" fill="#4E8F8B" />
      <rect x="6" y="11" width="20" height="10" rx="2" fill="#75ACA8" stroke="#1B1D1B" strokeWidth="1" />
      <circle cx="16" cy="16" r="2.4" fill="#4E8F8B" />
      <rect x="13" y="10.5" width="6" height="11" rx="0.5" fill="#F2F0E2" stroke="#1B1D1B" strokeWidth="0.8" />
      <rect x="6" y="25.5" width="20" height="1.6" rx="0.8" fill="#59B280" />
    </svg>
  );
}

/** "Litt's LOANS" wordmark, echoing the logo's light italic + heavy condensed italic pairing. */
export function Wordmark({ className, inverse = false }: { className?: string; inverse?: boolean }) {
  return (
    <span className={cn("inline-flex items-baseline gap-1 font-display italic leading-none", className)}>
      <span className={cn("text-[1.05em] font-light", inverse ? "text-sidebar-muted-foreground" : "text-muted-foreground")}>Litt&rsquo;s</span>
      <span className={cn("text-[1.3em] font-extrabold tracking-wide", inverse ? "text-sidebar-primary" : "text-primary")}>LOANS</span>
    </span>
  );
}

export function BrandLockup({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <LogoMark />
      <Wordmark className="text-lg" />
    </span>
  );
}
