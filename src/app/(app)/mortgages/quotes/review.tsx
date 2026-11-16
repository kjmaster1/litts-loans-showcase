"use client";

import { BadgeCheck, CircleCheck, Clock, MessageSquareWarning } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { LocalTime } from "@/components/data/local-time";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { addQuoteNoteAction, approveQuoteAction, resolveQuoteNoteAction } from "./actions";

/**
 * Reviewing a quote (research/18): management's notes on what needs changing, which the officer
 * marks done, and an executive's approval for quotes over the line.
 */

type Result = { ok: true } | { ok: false; error: string };

function useRun() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const run = (fn: () => Promise<Result>, success: string, after?: () => void) => {
    setError(null);
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) return setError(r.error);
      toast.success(success);
      after?.();
      router.refresh();
    });
  };
  return { run, error, pending };
}

export type ReviewNote = {
  id: string;
  text: string;
  at: string;
  staffName: string | null;
  done: { at: string; staffName: string | null; reply: string } | null;
};

const NOTE_FIELD = "review-note";

/** Moves the cursor to the "What needs changing?" box (from the approval panel's "Ask for changes"). */
function focusNoteField() {
  const el = document.getElementById(NOTE_FIELD);
  el?.scrollIntoView({ behavior: "smooth", block: "center" });
  el?.focus({ preventScroll: true });
}

function OpenNote({ note, canResolve }: { note: ReviewNote; canResolve: boolean }) {
  const { run, error, pending } = useRun();
  const [resolving, setResolving] = useState(false);
  const [reply, setReply] = useState("");
  return (
    <li className="rounded-lg border border-warning/40 bg-warning-subtle p-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="flex items-center gap-1.5 font-medium">
          <MessageSquareWarning className="size-4 shrink-0 text-warning" aria-hidden />
          {note.staffName ?? "Management"} asked for changes
        </span>
        <span className="text-xs text-muted-foreground">
          <LocalTime value={note.at} />
        </span>
      </div>
      <p className="mt-1.5 whitespace-pre-wrap [overflow-wrap:anywhere]">{note.text}</p>
      {canResolve ? (
        resolving ? (
          <form
            method="post"
            className="mt-3 flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              run(() => resolveQuoteNoteAction({ noteId: note.id, reply }), "Marked done.");
            }}
          >
            <Field className="min-w-48 flex-1">
              <FieldLabel htmlFor={`reply-${note.id}`}>Reply (optional)</FieldLabel>
              <Input id={`reply-${note.id}`} value={reply} onChange={(e) => setReply(e.target.value)} maxLength={300} placeholder="e.g. Fee lowered to 2%" autoFocus />
            </Field>
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? <Spinner /> : null}
              Mark done
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setResolving(false)} disabled={pending}>
              Cancel
            </Button>
            {error ? <FieldError className="basis-full">{error}</FieldError> : null}
          </form>
        ) : (
          <Button type="button" size="sm" variant="outline" className="mt-3 bg-background" onClick={() => setResolving(true)}>
            <CircleCheck aria-hidden /> Mark done…
          </Button>
        )
      ) : null}
    </li>
  );
}

function DoneNote({ note }: { note: ReviewNote }) {
  return (
    <li className="rounded-lg border p-3 text-sm text-muted-foreground">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span>
          <span className="font-medium text-foreground">{note.staffName ?? "Management"}</span> asked
        </span>
        <span className="text-xs">
          <LocalTime value={note.at} />
        </span>
      </div>
      <p className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{note.text}</p>
      <div className="mt-2 flex items-start gap-1.5 border-t pt-2 text-xs">
        <CircleCheck className="mt-px size-3.5 shrink-0 text-success" aria-hidden />
        <span className="[overflow-wrap:anywhere]">
          Done by {note.done!.staffName ?? "staff"}, <LocalTime value={note.done!.at} />
          {note.done!.reply ? <>: &ldquo;{note.done!.reply}&rdquo;</> : "."}
        </span>
      </div>
    </li>
  );
}

function AddNote({ quoteId, officerName }: { quoteId: string; officerName: string }) {
  const { run, error, pending } = useRun();
  const [text, setText] = useState("");
  return (
    <form
      method="post"
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => addQuoteNoteAction({ quoteId, text }), `Sent to ${officerName}.`, () => setText(""));
      }}
    >
      <Field>
        <FieldLabel htmlFor={NOTE_FIELD}>What needs changing?</FieldLabel>
        <Textarea id={NOTE_FIELD} rows={3} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Banker fee is over the 2% maximum for this band. Lower it to 2%." />
        <FieldDescription>{officerName} sees this on the quote and in their notifications until they mark it done.</FieldDescription>
        {error ? <FieldError>{error}</FieldError> : null}
      </Field>
      <Button type="submit" size="sm" disabled={pending || text.trim().length < 3}>
        {pending ? <Spinner /> : null}
        Send to {officerName}
      </Button>
    </form>
  );
}

/** The review notes card: open ones first, then the done ones as history. */
export function ReviewNotesCard({
  quoteId,
  notes,
  canAdd,
  canResolve,
  officerName,
  isOfficer,
}: {
  quoteId: string;
  notes: ReviewNote[];
  canAdd: boolean;
  canResolve: boolean;
  officerName: string;
  isOfficer: boolean;
}) {
  const open = notes.filter((n) => !n.done);
  const done = notes.filter((n) => n.done);
  return (
    <Card id="review">
      <CardHeader>
        <CardTitle>Review notes{open.length ? ` (${open.length} open)` : ""}</CardTitle>
        <CardDescription>
          {open.length
            ? isOfficer
              ? "Make the changes (Edit), then mark each note done. A short reply tells them what you did."
              : `Waiting for ${officerName} to make the changes and mark them done.`
            : notes.length
              ? "All done."
              : canAdd
                ? `Tell ${officerName} what needs changing instead of changing it yourself.`
                : "No notes from management."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {notes.length ? (
          <ul className="space-y-2" aria-label="Review notes">
            {open.map((n) => (
              <OpenNote key={n.id} note={n} canResolve={canResolve} />
            ))}
            {done.map((n) => (
              <DoneNote key={n.id} note={n} />
            ))}
          </ul>
        ) : null}
        {canAdd ? <AddNote quoteId={quoteId} officerName={officerName} /> : null}
      </CardContent>
    </Card>
  );
}

/** Open notes, read-only, above the edit form: what the officer was asked to change. */
export function OpenNotesReminder({ notes }: { notes: ReviewNote[] }) {
  if (!notes.length) return null;
  return (
    <Alert variant="warning">
      <MessageSquareWarning aria-hidden />
      <AlertTitle>
        {notes.length === 1 ? "1 change asked for" : `${notes.length} changes asked for`}
      </AlertTitle>
      <AlertDescription>
        <ul className="space-y-1.5">
          {notes.map((n) => (
            <li key={n.id} className="whitespace-pre-wrap [overflow-wrap:anywhere]">
              <span className="font-medium text-foreground">{n.staffName ?? "Management"}:</span> {n.text}
            </li>
          ))}
        </ul>
        <p className="mt-2">Save your changes, then mark each note done on the quote.</p>
      </AlertDescription>
    </Alert>
  );
}

/** A quote over the executive-approval line that isn't approved yet. */
export function ApprovalNeeded({
  quoteId,
  canApprove,
  canAskForChanges,
  over,
}: {
  quoteId: string;
  canApprove: boolean;
  canAskForChanges: boolean;
  /** "Down payment + loan $1,250,000 is over $1,000,000" */
  over: string;
}) {
  const { run, error, pending } = useRun();
  if (!canApprove) {
    return (
      <Alert variant="warning">
        <Clock aria-hidden />
        <AlertTitle>Waiting for an executive&rsquo;s approval</AlertTitle>
        <AlertDescription>
          {over}, so an executive (Owner, CEO or COO) must approve this quote before it goes on the tablet. They&rsquo;ve been notified. Don&rsquo;t enter it on the tablet yet.
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Card className="border-warning/40 bg-warning-subtle">
      <CardHeader>
        <CardTitle>Needs your approval</CardTitle>
        <CardDescription className="text-foreground/80">
          {over}. Check the terms below, then approve it so the officer can enter it on the tablet{canAskForChanges ? ", or ask for changes" : ""}.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2">
        <Button type="button" disabled={pending} onClick={() => run(() => approveQuoteAction({ id: quoteId }), "Quote approved.")}>
          {pending ? <Spinner /> : <BadgeCheck aria-hidden />}
          Approve quote
        </Button>
        {canAskForChanges ? (
          <Button type="button" variant="outline" className="bg-background" onClick={focusNoteField}>
            Ask for changes
          </Button>
        ) : null}
        {error ? <FieldError className="basis-full">{error}</FieldError> : null}
      </CardContent>
    </Card>
  );
}
