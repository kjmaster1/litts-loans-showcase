"use client";

import { Monitor } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";
import { LocalTime } from "@/components/data/local-time";
import { StatusBadge } from "@/components/data/status-badge";
import { Button } from "@/components/ui/button";
import { revokeOtherSessionsAction, revokeSessionAction } from "./actions";

type Session = { id: string; current: boolean; createdAt: string; lastActiveAt: string; ip: string | null; device: string };

export function SessionsList({ sessions }: { sessions: Session[] }) {
  const [pending, startTransition] = useTransition();
  const others = sessions.filter((s) => !s.current).length;

  return (
    <div className="space-y-4">
      <ul className="divide-y rounded-lg border">
        {sessions.map((s) => (
          <li key={s.id} className="flex items-center gap-3 p-3">
            <Monitor className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1 text-sm">
              <div className="flex items-center gap-2 font-medium">
                {s.device}
                {s.current ? <StatusBadge tone="success">This device</StatusBadge> : null}
              </div>
              <div className="text-xs text-muted-foreground">
                {s.ip ? <span className="ident">{s.ip}</span> : "Unknown IP"} · active{" "}
                <LocalTime value={s.lastActiveAt} format="relative" /> · signed in <LocalTime value={s.createdAt} />
              </div>
            </div>
            {!s.current ? (
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    const r = await revokeSessionAction(s.id);
                    if (r.ok) toast.success("Session ended.");
                    else toast.error(r.error);
                  })
                }
              >
                Sign out
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {others > 0 ? (
        <Button
          variant="outline"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const r = await revokeOtherSessionsAction();
              if (r.ok) toast.success(`Signed out of ${r.data} other session(s).`);
              else toast.error(r.error);
            })
          }
        >
          Sign out of all other sessions
        </Button>
      ) : null}
    </div>
  );
}
