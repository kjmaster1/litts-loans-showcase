"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { ArrowRight, ArrowUpRight, Compass, PanelLeft, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { completeTourAction } from "@/app/(app)/tour-action";
import { startNavigationProgress } from "@/components/app-shell/navigation-progress";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/use-mobile";
import type { Role } from "@/lib/roles";
import { cn } from "@/lib/utils";
import { buildTour, tourToOffer, welcome, type Device, type Tour } from "./tour-steps";

/** Window event that starts the full tour (account menu). */
export const START_TOUR = "litts:tour";

type Phase = { kind: "closed" } | { kind: "welcome" } | { kind: "step"; index: number } | { kind: "finish" };
type Rect = { top: number; left: number; width: number; height: number; inSidebar: boolean };

const CARD_WIDTH = 360;
const GAP = 14;
const LATER = "You can take the tour any time from your account menu.";

/** Only the tour's own buttons and Escape close it: a stray click on the dimmed page shouldn't end it for good. */
const deliberate = (reason: string) => reason === "escape-key" || reason === "close-press";

/**
 * The app tour (docs/design/TUTORIAL-2026-10-12.md): a welcome card on someone's first visit,
 * then a spotlight on each part of the app their role can use, then where to start. Finishing
 * or skipping is remembered on their staff record; a later promotion gets just what's new. It
 * lives in the layout, so a page opened from the tour loads behind it and the tour carries on.
 */
export function AppTour({ role, firstName, completedAt, touredAs }: { role: Role; firstName: string; completedAt: string | null; touredAs: Role | null }) {
  const device: Device = useIsMobile() ? "phone" : "desktop";
  // Decided once, when the app opens: saving "done" later (and any refresh that brings it back as
  // a prop) mustn't make the tour vanish mid-card. `since`: the role a "what's new" tour is from.
  const [source, setSource] = useState<{ since: Role | null } | null>(() => {
    const offer = tourToOffer(role, completedAt, touredAs);
    return offer ? { since: offer.kind === "new_role" ? touredAs : null } : null;
  });
  const [phase, setPhase] = useState<Phase>(() => (source ? { kind: "welcome" } : { kind: "closed" }));
  const saved = useRef(false);
  const tour = source ? buildTour(role, source.since, device) : null;

  const remember = useCallback(() => {
    if (saved.current) return;
    saved.current = true;
    void completeTourAction();
  }, []);

  // From the account menu: the full tour, straight to the first stop.
  useEffect(() => {
    const start = () => {
      setSource({ since: null });
      setPhase({ kind: "step", index: 0 });
    };
    window.addEventListener(START_TOUR, start);
    return () => window.removeEventListener(START_TOUR, start);
  }, []);

  if (!tour || phase.kind === "closed") return null;

  const close = (message?: string) => {
    remember();
    setPhase({ kind: "closed" });
    if (message) toast(message);
  };

  if (phase.kind === "welcome") return <Welcome tour={tour} firstName={firstName} onStart={() => setPhase({ kind: "step", index: 0 })} onLater={() => close(LATER)} />;
  if (phase.kind === "finish") return <Finish tour={tour} onClose={() => close()} />;
  return (
    <StepCard
      tour={tour}
      index={phase.index}
      device={device}
      onBack={() => setPhase({ kind: "step", index: Math.max(0, phase.index - 1) })}
      onNext={() => {
        if (phase.index + 1 < tour.steps.length) setPhase({ kind: "step", index: phase.index + 1 });
        else {
          remember();
          setPhase({ kind: "finish" });
        }
      }}
      onSkip={() => close(LATER)}
    />
  );
}

function CenteredCard({ title, children, footer, onDismiss }: { title: string; children: React.ReactNode; footer: React.ReactNode; onDismiss: () => void }) {
  return (
    <DialogPrimitive.Root open onOpenChange={(open, details) => (!open && deliberate(details.reason) ? onDismiss() : undefined)}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/45 data-open:animate-in data-open:fade-in-0" />
        <DialogPrimitive.Popup
          data-tour-card=""
          className="fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl bg-popover text-sm text-popover-foreground shadow-xl ring-1 ring-foreground/10 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95"
        >
          <div className="flex items-center gap-3 bg-sidebar px-5 py-4 text-sidebar-foreground">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-sidebar-accent text-sidebar-primary">
              <Compass className="size-5" aria-hidden />
            </span>
            <DialogPrimitive.Title className="text-base leading-tight font-semibold">{title}</DialogPrimitive.Title>
          </div>
          <DialogPrimitive.Description render={<div />} className="space-y-3 px-5 pt-4 leading-relaxed">
            {children}
          </DialogPrimitive.Description>
          <div className="flex flex-wrap justify-end gap-2 px-5 pt-5 pb-5">{footer}</div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function Welcome({ tour, firstName, onStart, onLater }: { tour: Tour; firstName: string; onStart: () => void; onLater: () => void }) {
  const w = welcome(tour, firstName);
  return (
    <CenteredCard
      title={w.title}
      onDismiss={onLater}
      footer={
        <>
          <Button variant="outline" onClick={onLater}>
            Not now
          </Button>
          <Button autoFocus onClick={onStart}>
            {tour.kind === "new_role" ? "Start" : "Start the tour"} <ArrowRight aria-hidden />
          </Button>
        </>
      }
    >
      <p>{w.text}</p>
      {/* What's coming, so "a tour" has a known length. */}
      <ol className="space-y-1.5">
        {tour.steps.map((s, i) => (
          <li key={s.id} className="flex items-center gap-2.5">
            <span className="num grid size-5 shrink-0 place-items-center rounded-full bg-muted text-xs font-medium text-muted-foreground">{i + 1}</span>
            {s.title}
          </li>
        ))}
      </ol>
      <p className="text-xs text-muted-foreground">{tour.kind === "new_role" ? "Under a minute." : "About a minute. You can take it again from your account menu."}</p>
    </CenteredCard>
  );
}

function Finish({ tour, onClose }: { tour: Tour; onClose: () => void }) {
  const pathname = usePathname();
  // Never offer the page they're already on: "See what needs attention" on the dashboard did nothing.
  const [first, second] = tour.finish.actions.filter((a) => a.href !== pathname);
  return (
    <CenteredCard
      title={tour.finish.title}
      onDismiss={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          {first ? (
            <Button autoFocus render={<Link href={first.href} onClick={onClose} />}>
              {first.label} <ArrowRight aria-hidden />
            </Button>
          ) : null}
        </>
      }
    >
      <p>{tour.finish.text}</p>
      {second ? (
        <p className="text-muted-foreground">
          Or{" "}
          <Link href={second.href} onClick={onClose} className="font-medium text-foreground underline underline-offset-4">
            {second.label.charAt(0).toLowerCase() + second.label.slice(1)}
          </Link>
          .
        </p>
      ) : null}
    </CenteredCard>
  );
}

/** Where the stop's element is on screen, or null when it isn't showing. */
function useTargetRect(target: string | null, index: number): Rect | null {
  const pathname = usePathname();
  // Keyed by stop and page (a page opened from the tour brings a new top bar).
  const key = `${index}:${target}:${pathname}`;
  const [found, setFound] = useState<{ key: string; rect: Rect | null } | null>(null);
  useLayoutEffect(() => {
    const el = target ? document.querySelector<HTMLElement>(`[data-tour="${target}"]`) : null;
    if (!el) return;
    el.scrollIntoView({ block: "nearest" });
    const inSidebar = el.closest("[data-sidebar=sidebar]") !== null;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const visible = r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
      setFound({ key, rect: visible ? { top: r.top, left: r.left, width: r.width, height: r.height, inSidebar } : null });
    };
    const frame = requestAnimationFrame(measure);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [key, target]);
  return found?.key === key ? found.rect : null;
}

/** Beside the element if there's room (right, then below, then above); else the middle of the screen. */
function place(rect: Rect | null, cardHeight: number): { top: number; left: number } | null {
  if (!rect) return null;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(CARD_WIDTH, vw - 32);
  const clampTop = (t: number) => Math.max(16, Math.min(t, vh - cardHeight - 16));
  const clampLeft = (l: number) => Math.max(16, Math.min(l, vw - width - 16));
  if (rect.left + rect.width + GAP + width + 16 <= vw) return { left: rect.left + rect.width + GAP, top: clampTop(rect.top) };
  if (rect.top + rect.height + GAP + cardHeight + 16 <= vh) return { top: rect.top + rect.height + GAP, left: clampLeft(rect.left + rect.width - width) };
  if (rect.top - GAP - cardHeight >= 16) return { top: rect.top - GAP - cardHeight, left: clampLeft(rect.left + rect.width - width) };
  return null;
}

function StepCard({ tour, index, device, onBack, onNext, onSkip }: { tour: Tour; index: number; device: Device; onBack: () => void; onNext: () => void; onSkip: () => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const step = tour.steps[index];
  const onPhoneMenu = device === "phone" && step.phoneTarget !== undefined;
  const rect = useTargetRect(onPhoneMenu ? step.phoneTarget! : step.target, index);
  const cardRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [height, setHeight] = useState(320);
  const last = index === tour.steps.length - 1;
  const linked = step.items?.some((i) => i.href);

  useLayoutEffect(() => {
    if (cardRef.current) setHeight(cardRef.current.offsetHeight);
  }, [index, rect]);
  // A new stop: move focus to its title so a screen reader reads it.
  useEffect(() => titleRef.current?.focus(), [index]);

  const at = place(rect, height);
  // In the sidebar the highlight sits inside its edge (a pad would show a sliver of page beside the dark sidebar).
  const pad = rect?.inSidebar ? 0 : 6;
  const open = (href: string) => {
    if (href === pathname) return;
    startNavigationProgress();
    router.push(href);
  };

  return (
    <DialogPrimitive.Root open onOpenChange={(isOpen, details) => (!isOpen && deliberate(details.reason) ? onSkip() : undefined)}>
      <DialogPrimitive.Portal>
        {/* The spotlight: everything dimmed except the part of the app this stop is about. */}
        {rect ? (
          <div
            aria-hidden
            className={cn(
              "pointer-events-none fixed z-50 transition-[top,left,width,height] duration-200 motion-reduce:transition-none",
              // An outline, not a ring: rings are box-shadows, which the dimming shadow below would replace.
              rect.inSidebar ? "rounded-md outline-2 -outline-offset-2 outline-sidebar-primary" : "rounded-lg outline-2 outline-primary",
            )}
            style={{ top: rect.top - pad, left: rect.left - pad, width: rect.width + pad * 2, height: rect.height + pad * 2, boxShadow: "0 0 0 9999px rgb(0 0 0 / 0.5)" }}
          />
        ) : null}
        <DialogPrimitive.Backdrop className={cn("fixed inset-0 z-50", rect ? "bg-transparent" : "bg-black/50")} />
        <DialogPrimitive.Popup
          ref={cardRef}
          data-tour-card=""
          initialFocus={titleRef}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight") onNext();
            else if (e.key === "ArrowLeft" && index > 0) onBack();
          }}
          className={cn(
            "fixed z-50 flex max-h-[calc(100dvh-2rem)] w-[min(22.5rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl bg-popover text-sm text-popover-foreground shadow-xl ring-1 ring-foreground/10 outline-none",
            at ? "transition-[top,left] duration-200 motion-reduce:transition-none" : "top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2",
          )}
          style={at ? { top: at.top, left: at.left } : undefined}
        >
          {/* Progress: a bar you can see at a glance, and the words for a screen reader. */}
          <div className="h-1 bg-muted" aria-hidden>
            <div className="h-full bg-primary transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${((index + 1) / tour.steps.length) * 100}%` }} />
          </div>
          <div className="flex items-start justify-between gap-3 px-4 pt-3">
            <div className="min-w-0">
              <p className="text-xs font-medium text-muted-foreground">
                {tour.kind === "new_role" ? "What’s new" : "Step"} {index + 1} of {tour.steps.length}
              </p>
              <DialogPrimitive.Title ref={titleRef} tabIndex={-1} className="mt-0.5 text-base leading-tight font-semibold outline-none">
                {step.title}
              </DialogPrimitive.Title>
            </div>
            <DialogPrimitive.Close render={<Button variant="ghost" size="icon-sm" aria-label="Close the tour" className="-mr-1.5" />}>
              <X aria-hidden />
            </DialogPrimitive.Close>
          </div>
          <DialogPrimitive.Description render={<div />} className="min-h-0 space-y-3 overflow-y-auto px-4 pt-2 leading-snug">
            {onPhoneMenu ? (
              <p className="flex items-center gap-2 rounded-md bg-muted px-2.5 py-1.5 text-xs">
                <PanelLeft className="size-4 shrink-0" aria-hidden /> Tap the highlighted menu button to find {step.id === "account" ? "your account" : "these"}.
              </p>
            ) : null}
            {step.intro ? <p className="text-muted-foreground">{step.intro}</p> : null}
            {step.items ? (
              <ul className="space-y-1">
                {step.items.map((item) => (
                  <li key={item.title} className="flex gap-2.5 rounded-md py-1.5">
                    {item.icon ? <item.icon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden /> : <Compass className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />}
                    <div className="min-w-0">
                      {item.href ? (
                        <button
                          type="button"
                          onClick={() => open(item.href!)}
                          aria-current={item.href === pathname ? "page" : undefined}
                          className="group inline-flex items-center gap-1 rounded-sm font-medium underline-offset-4 hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none aria-[current=page]:no-underline"
                        >
                          {item.title}
                          {item.href === pathname ? (
                            <span className="text-xs font-normal text-muted-foreground">· open now</span>
                          ) : (
                            <ArrowUpRight className="size-3.5 text-muted-foreground transition-transform group-hover:-translate-y-px group-hover:translate-x-px" aria-hidden />
                          )}
                        </button>
                      ) : (
                        <p className="font-medium">{item.title}</p>
                      )}
                      <p className="text-muted-foreground">{item.text}</p>
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
            {linked && index === 0 ? <p className="text-xs text-muted-foreground">{device === "phone" ? "Tap" : "Click"} a name to open that page behind the tour.</p> : null}
          </DialogPrimitive.Description>
          <div className="flex items-center justify-between gap-3 px-4 pt-3 pb-4">
            {last ? (
              <span />
            ) : (
              <Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground" onClick={onSkip}>
                Skip tour
              </Button>
            )}
            <div className="flex gap-2">
              {index > 0 ? (
                <Button variant="outline" size="sm" onClick={onBack}>
                  Back
                </Button>
              ) : null}
              <Button size="sm" onClick={onNext}>
                {last ? "Finish" : "Next"}
                {last ? null : <ArrowRight aria-hidden />}
              </Button>
            </div>
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
