"use client";

import { Popover } from "@base-ui/react/popover";
import { BadgeCheck, Bell, CalendarClock, CircleDollarSign, CopyX, FileCheck, Gavel, HandCoins, Landmark, MessageSquareReply, MessageSquareWarning, PhoneCall, ShieldAlert, ShieldX, Tablet, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { Suspense, use, useState, useTransition } from "react";
import { markNotificationsReadAction, notificationsAction } from "@/app/(app)/notifications-action";
import { LocalTime } from "@/components/data/local-time";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Notification } from "@/server/notifications";
import { startNavigationProgress } from "./navigation-progress";
import { useShell } from "./shell-context";

const ICON: Record<Notification["kind"], typeof Bell> = {
  broken_promise: HandCoins,
  follow_up: PhoneCall,
  write_off: CircleDollarSign,
  close_week: CalendarClock,
  unconfirmed_record: CopyX,
  federal_breach: ShieldAlert,
  quote_changes: MessageSquareWarning,
  quote_reply: MessageSquareReply,
  quote_approval: FileCheck,
  quote_approved: BadgeCheck,
  quote_signing_passed: CalendarClock,
  quote_awaiting_tablet: Tablet,
  quote_pushed_short: TriangleAlert,
  unapproved_mortgage: ShieldX,
  legal_details_requested: Gavel,
  legal_fee_unpaid: Landmark,
};

const triggerClass = cn(buttonVariants({ variant: "ghost", size: "icon" }), "relative size-8");

/** In-app notifications (research/12): nothing leaves the app. */
export function NotificationBell() {
  const { notifications } = useShell();
  return (
    <Suspense
      fallback={
        <button type="button" className={triggerClass} disabled aria-label="Notifications">
          <Bell aria-hidden />
        </button>
      }
    >
      <BellPopover initial={notifications} />
    </Suspense>
  );
}

function BellPopover({ initial }: { initial: Promise<Notification[]> }) {
  const first = use(initial);
  const [open, setOpen] = useState(false);
  // Fresh data from the layout (after a refresh) wins over what was fetched before.
  const { bell: fetched, setBell: setFetched } = useShell();
  const items = fetched && fetched.from === first ? fetched.items : first;
  const update = (fn: (list: Notification[]) => Notification[]) => setFetched((f) => ({ from: first, items: fn(f && f.from === first ? f.items : first) }));
  const [loading, startLoading] = useTransition();
  const unread = items.filter((i) => !i.read).length;

  const markRead = (keys: string[]) => {
    if (!keys.length) return;
    update((list) => list.map((i) => (keys.includes(i.key) ? { ...i, read: true } : i)));
    void markNotificationsReadAction({ keys });
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) return;
        startLoading(async () => {
          const r = await notificationsAction();
          if (r.ok) update(() => r.data);
        });
      }}
    >
      <Popover.Trigger className={triggerClass} aria-label={unread ? `Notifications, ${unread} new` : "Notifications"}>
        <Bell aria-hidden />
        {unread ? (
          <span
            className="absolute -top-0.5 -right-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-danger px-1 text-[10px] leading-none font-semibold text-background tabular-nums"
            aria-hidden
          >
            {unread > 9 ? "9+" : unread}
          </span>
        ) : null}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner className="isolate z-50" align="end" sideOffset={6}>
          <Popover.Popup className="w-[min(24rem,calc(100vw-2rem))] origin-(--transform-origin) rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none">
            <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
              <Popover.Title className="text-sm font-semibold">Notifications</Popover.Title>
              {unread ? (
                <button type="button" className="text-xs text-primary underline-offset-4 hover:underline" onClick={() => markRead(items.filter((i) => !i.read).map((i) => i.key))}>
                  Mark all as read
                </button>
              ) : null}
            </div>
            {items.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">{loading ? "Checking…" : "Nothing needs your attention."}</p>
            ) : (
              <ul className="max-h-[min(70vh,28rem)] divide-y overflow-y-auto">
                {items.map((n) => {
                  const Icon = ICON[n.kind];
                  return (
                    <li key={n.key}>
                      <Link
                        href={n.href}
                        className="flex items-start gap-2.5 px-3 py-2 hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none"
                        onClick={() => {
                          markRead([n.key]);
                          setOpen(false);
                          startNavigationProgress();
                        }}
                      >
                        <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", n.kind === "broken_promise" || n.kind === "write_off" || n.kind === "unconfirmed_record" || n.kind === "federal_breach" || n.kind === "unapproved_mortgage" || n.kind === "quote_pushed_short" || n.kind === "legal_fee_unpaid" ? "text-danger" : "text-muted-foreground")} />
                        <span className="grid min-w-0 flex-1 gap-0.5">
                          <span className={cn("text-sm", n.read ? "text-muted-foreground" : "font-medium")}>
                            {n.title}
                            {n.read ? null : <span className="sr-only"> (new)</span>}
                          </span>
                          <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{n.detail}</span>
                          <span className="text-xs text-muted-foreground">
                            <LocalTime value={n.at} format="relative" />
                          </span>
                        </span>
                        {n.read ? null : <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" aria-hidden />}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
