"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/** The browser's IANA time zone ("Europe/Berlin"). Null during SSR/hydration: the server can't know it. */
export function useTimeZone(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    () => null,
  );
}
