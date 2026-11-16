"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { authClient } from "@/lib/auth-client";
import { SESSION_IDLE_SECONDS, SESSION_REFRESH_SECONDS } from "@/lib/session-policy";
import { signOutAndLeave } from "./user-menu";

/**
 * Client half of the idle timeout. The server enforces the 60-minute sliding
 * expiry regardless; this component makes it humane:
 * - real activity (pointer, keys, scroll) — not just page loads — keeps the
 *   session alive by refreshing it at most once per refresh interval;
 * - a warning with a countdown appears 5 minutes before expiry;
 * - activity is shared across tabs via localStorage, so working in one tab
 *   doesn't sign out another.
 */
const WARN_BEFORE_MS = 5 * 60 * 1000;
const IDLE_MS = SESSION_IDLE_SECONDS * 1000;
const STORAGE_KEY = "litts:last-activity";
const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart", "mousemove"] as const;

function readShared(): number {
  try {
    return Number(localStorage.getItem(STORAGE_KEY)) || 0;
  } catch {
    return 0;
  }
}

export function SessionGuard() {
  const router = useRouter();
  const lastActivity = useRef(0);
  const lastRefresh = useRef(0);
  const leaving = useRef(false);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  const markActive = useCallback(() => {
    const now = Date.now();
    // Throttle writes: mousemove fires constantly.
    if (now - lastActivity.current < 5_000) return;
    lastActivity.current = now;
    try {
      localStorage.setItem(STORAGE_KEY, String(now));
    } catch {
      // storage unavailable — per-tab tracking still works
    }
  }, []);

  const refresh = useCallback(async () => {
    lastRefresh.current = Date.now();
    const { data } = await authClient.getSession();
    if (!data && !leaving.current) {
      leaving.current = true;
      router.replace("/sign-in?reason=idle");
    }
  }, [router]);

  useEffect(() => {
    const now = Date.now();
    lastActivity.current = now;
    lastRefresh.current = now;
    for (const e of ACTIVITY_EVENTS) window.addEventListener(e, markActive, { passive: true });

    const tick = window.setInterval(() => {
      const now = Date.now();
      const last = Math.max(lastActivity.current, readShared());
      const idleFor = now - last;

      if (idleFor >= IDLE_MS) {
        if (!leaving.current) {
          leaving.current = true;
          void signOutAndLeave(router, "idle");
        }
        return;
      }
      if (idleFor >= IDLE_MS - WARN_BEFORE_MS) {
        setSecondsLeft(Math.ceil((IDLE_MS - idleFor) / 1000));
        return;
      }
      setSecondsLeft(null);
      // Active since the last refresh → extend the server-side session.
      if (last > lastRefresh.current && now - lastRefresh.current >= SESSION_REFRESH_SECONDS * 1000) {
        void refresh();
      }
    }, 1_000);

    return () => {
      window.clearInterval(tick);
      for (const e of ACTIVITY_EVENTS) window.removeEventListener(e, markActive);
    };
  }, [markActive, refresh, router]);

  const open = secondsLeft !== null;
  const minutes = Math.floor((secondsLeft ?? 0) / 60);
  const seconds = String((secondsLeft ?? 0) % 60).padStart(2, "0");

  return (
    <AlertDialog open={open}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Are you still there?</AlertDialogTitle>
          <AlertDialogDescription>
            For security you&rsquo;ll be signed out in{" "}
            <span className="num font-medium text-foreground" aria-live="polite">
              {minutes}:{seconds}
            </span>{" "}
            unless you continue.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => void signOutAndLeave(router, "signed_out")}>Sign out now</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              lastActivity.current = 0;
              markActive();
              setSecondsLeft(null);
              void refresh();
            }}
          >
            Stay signed in
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
