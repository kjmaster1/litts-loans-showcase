import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageBody, PageHeader } from "@/components/app-shell/page-header";
import { CopyBlock } from "@/components/data/copy-block";
import { Fact } from "@/components/data/fact";
import { Kpi, StatStrip } from "@/components/data/kpi";
import { LocalTime } from "@/components/data/local-time";
import { Money } from "@/components/data/money";
import { PhoneHelper } from "@/components/data/phone-helper";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { feeComment, londonDay, sheetText, type CaseSheet, type DefaultRule } from "@/domain/legal/case-sheet";
import { dateFormat, formatCents } from "@/lib/format";
import { bookmarklet, phoneList } from "@/lib/pay-helper";
import { canAnnotateLoan, canCloseCase, canHandToLegal } from "@/server/authz/rules";
import { requireViewer } from "@/server/authz/viewer";
import { getCase, type CaseMissing } from "@/server/legal/cases";
import { AskOfficerButton, CloseCaseButton, ConfirmFeeButton, ContractDetailsForm, ContractNoteForm, ContractSharedToggle, DefaultDateForm, HandToLegalButton, UnlinkFeeButton } from "../case-forms";
import { CaseStateBadge } from "../case-state";

export const metadata: Metadata = { title: "Legal case" };

const DAY = dateFormat({ day: "numeric", month: "short", year: "numeric", timeZone: "Europe/London" });

const MISSING: Record<CaseMissing, string> = {
  card: "No phone card for this loan yet: paste the Default tab.",
  default_date: "The default date: it was moved to Default by hand and the phone card doesn’t say when the payments were missed. Set it below.",
  fee_per_day: "The Defaulted Account Fee per day, from the signed contract.",
  collateral: "The collateral from the contract, or tick Unsecured.",
  collateral_conflict: "It’s ticked Unsecured, but collateral is recorded on the loan: untick Unsecured, or mark that collateral Released.",
};

const RULE: Record<DefaultRule, string> = {
  game: "Third missed payment: the game defaulted it.",
  hand_moved: "Second missed payment: moved to Default by hand.",
  override: "Set by hand.",
  unconfirmed: "Moved to Default by hand; date not known. Set it below.",
};

/** One legal case: the sheet for the lawyer, what's missing, the hand-over, the fee and the money since. */
export default async function LegalCasePage({ params }: PageProps<"/loans/legal/[loanId]">) {
  const viewer = await requireViewer();
  const { loanId } = await params;
  const c = await getCase(viewer, loanId);
  if (!c) notFound();
  const owned = { officerStaffId: c.officerStaffId };
  const mayEdit = canAnnotateLoan(viewer, owned);
  const mayHand = canHandToLegal(viewer, owned);
  const manager = canCloseCase(viewer);
  const frozen = c.handover?.sheet as CaseSheet | undefined;
  const sheet = frozen ? c.handover!.text : c.preview ? sheetText(c.preview) : null;
  const comment = c.number ? feeComment(c.borrowerName, c.number) : null;
  const officer = c.officerName ?? "the officer";

  return (
    <>
      <PageHeader
        title={c.borrowerName}
        crumbs={[{ label: "Legal cases", href: "/loans/legal" }]}
        meta={<CaseStateBadge state={c.state} />}
        description={
          <>
            State ID <span className="ident">{c.stateId}</span>
            {c.number ? <> · Case LC{c.number}</> : null} · {c.officerName ?? "No officer"} ·{" "}
            <Link href={`/loans/${c.loanId}`} className="text-primary underline underline-offset-4">
              The loan
            </Link>
          </>
        }
        actions={
          c.state === "closed" ? null : (
            <>
              {mayHand && (c.state === "ready" || (c.state === "with_legal" && manager)) && c.preview ? (
                <HandToLegalButton loanId={c.loanId} legalStaff={c.legalStaff} again={c.state === "with_legal"} totalCents={c.preview.totalCents} />
              ) : null}
              {manager ? <CloseCaseButton loanId={c.loanId} /> : null}
            </>
          )
        }
      />
      <PageBody className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="min-w-0 space-y-6">
          {c.handover ? (
            <StatStrip cols={5}>
              <Kpi label="Claim" hint={`handed over ${DAY.format(c.handover.handedAt)}`}>
                <Money cents={frozen!.totalCents} />
              </Kpi>
              <Kpi label="Fee paid" tone={c.feePaid ? undefined : "warn"} hint={c.feePaid ? "to the lawyer" : `${formatCents(c.feeCents)} due`}>
                <Money cents={c.feePaidCents} />
              </Kpi>
              <Kpi label="Recovered" hint="collateral sale, seizure, payments">
                <Money cents={c.recoveredSinceHandoverCents} />
              </Kpi>
              <Kpi label="Net for Litt’s" tone={c.netForLittsCents < 0 ? "bad" : undefined} hint="recovered − fee">
                <Money cents={c.netForLittsCents} />
              </Kpi>
              <Kpi label="Still owed" hint="claim − recovered">
                {c.stillOwedCents === null ? "—" : <Money cents={c.stillOwedCents} />}
              </Kpi>
            </StatStrip>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Case sheet</CardTitle>
              <CardDescription>
                {frozen
                  ? `As handed to Legal on ${DAY.format(c.handover!.handedAt)}${c.earlierHandovers ? ` (replaces ${c.earlierHandovers === 1 ? "an earlier hand-over" : `${c.earlierHandovers} earlier hand-overs`})` : ""}. It doesn’t change.`
                  : sheet
                    ? "Preview, counted to today. Hand it to Legal to fix the days and send it."
                    : "Not ready yet: see what’s missing."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {sheet ? (
                <CopyBlock text={sheet} label="case sheet" />
              ) : (
                <ul className="list-disc space-y-1 pl-5 text-sm">
                  {c.missing.map((m) => (
                    <li key={m}>{MISSING[m]}</li>
                  ))}
                </ul>
              )}
              {c.handover?.reason ? <p className="mt-3 text-sm text-muted-foreground">Handed over again: {c.handover.reason}</p> : null}
              {c.contractNote ? (
                <div className="mt-3 rounded-md border border-warning/40 bg-warning-subtle p-3 text-sm">
                  <p className="font-medium">The contract says {formatCents(c.contractNote.cents)} a week</p>
                  <p className="text-muted-foreground">
                    The sheet claims what the game charges{c.cardInstalmentCents !== null ? ` (${formatCents(c.cardInstalmentCents)} on the latest phone card)` : ""}. {c.contractNote.reason}
                    {" "}— {c.contractNote.byName ?? "management"}, <LocalTime value={c.contractNote.at} format="date" />
                  </p>
                </div>
              ) : null}
            </CardContent>
          </Card>

          {c.handover ? (
            <Card>
              <CardHeader>
                <CardTitle>Attorney &amp; filing fee</CardTitle>
                <CardDescription>
                  {c.feePaid
                    ? "Paid. The bank shows it below."
                    : `${formatCents(c.feeCents)} to ${c.payee?.name ?? "the lawyer"} (State ID ${c.payee?.stateId ?? "?"}), from the business wallet with Pay Employee. Use this comment so the next bank import links it.`}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 px-0">
                {!c.feePaid && comment && c.payee ? (
                  <>
                    <dl className="px-6">
                      <Fact label="State ID">{c.payee.stateId}</Fact>
                      <Fact label="Amount">{formatCents(c.feeCents)}</Fact>
                      <Fact label="Comment">
                        <span className="font-mono text-xs">{comment}</span>
                      </Fact>
                    </dl>
                    <PhoneHelper list={phoneList([{ name: c.payee.name, stateId: c.payee.stateId, owedCents: c.feeCents, comment }])} bookmarklet={bookmarklet()} />
                  </>
                ) : null}
                {c.feePayments.length ? (
                  <ul className="divide-y border-y px-6 text-sm">
                    {c.feePayments.map((f) => (
                      <li key={f.txId} className="flex flex-wrap justify-between gap-2 py-2">
                        <span className="min-w-0 break-words">{f.comment}</span>
                        <span className="flex items-center gap-2 text-muted-foreground">
                          <Money cents={f.amountCents} /> · <LocalTime value={f.occurredAt} format="date" />
                          {manager ? <UnlinkFeeButton loanId={c.loanId} txId={f.txId} /> : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {c.feeSuggestions.length ? (
                  <div className="space-y-2 px-6">
                    <p className="text-sm font-medium">Payments that look like this fee</p>
                    <ul className="divide-y rounded-lg border text-sm">
                      {c.feeSuggestions.map((f) => (
                        <li key={f.txId} className="flex flex-wrap items-center justify-between gap-2 p-3">
                          <span className="min-w-0 break-words">
                            {f.comment}
                            <span className="block text-xs text-muted-foreground">
                              {formatCents(f.amountCents)} · {DAY.format(f.occurredAt)}
                            </span>
                          </span>
                          {mayEdit ? <ConfirmFeeButton loanId={c.loanId} txId={f.txId} /> : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ) : null}
        </div>

        <div className="space-y-6">
          <Card size="sm">
            <CardHeader>
              <CardTitle>Contract details</CardTitle>
              <CardDescription>Only the signed contract has these. {c.officerName ? `${c.officerName} issued it.` : ""}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <dl>
                <Fact label="Fee per day" labelWidth="9.5rem">
                  {c.feePerDayCents ? <Money cents={c.feePerDayCents} /> : <span className="text-muted-foreground">Not recorded</span>}
                </Fact>
                <Fact label="Instalment" labelWidth="9.5rem">
                  {c.cardInstalmentCents !== null ? <Money cents={c.cardInstalmentCents} /> : <span className="text-muted-foreground">No phone card yet</span>}
                  <span className="block text-xs text-muted-foreground">
                    {c.contractNote ? <>The game’s amount. The contract says {formatCents(c.contractNote.cents)}</> : "From the latest phone card"}
                  </span>
                </Fact>
                <Fact label="Collateral" labelWidth="9.5rem">
                  {c.collateral ?? <span className="text-muted-foreground">Not recorded</span>}
                </Fact>
                <Fact label="Defaulted" labelWidth="9.5rem">
                  {c.defaultAt ? DAY.format(c.defaultAt) : "—"}
                  <span className="block text-xs text-muted-foreground">{RULE[c.defaultRule]}</span>
                </Fact>
                <Fact label="Officer asked" labelWidth="9.5rem">
                  {c.detailsRequestedAt ? <LocalTime value={c.detailsRequestedAt} /> : "No"}
                </Fact>
              </dl>
              {c.state === "needs_details" && c.officerStaffId && c.officerStaffId !== viewer.staffId ? (
                c.officerWorking ? (
                  <AskOfficerButton loanId={c.loanId} officerName={officer} asked={c.detailsRequestedAt !== null} />
                ) : (
                  <p className="text-sm text-muted-foreground">{officer} no longer works for Litt’s: fill in the details below, or give the loan a new officer.</p>
                )
              ) : null}
              <ContractSharedToggle loanId={c.loanId} shared={c.contractSharedAt !== null} canEdit={mayEdit} />
              {mayEdit && (!c.handover || manager) && c.state !== "closed" ? <ContractDetailsForm loanId={c.loanId} feePerDayCents={c.feePerDayCents} unsecured={c.unsecured} collateral={c.collateral} /> : null}
              {mayHand && (!c.handover || manager) && c.state !== "closed" ? (
                <DefaultDateForm loanId={c.loanId} current={c.defaultAt ? londonDay(c.defaultAt) : null} overridden={c.defaultAtOverride !== null} />
              ) : null}
              {manager && c.state !== "closed" ? <ContractNoteForm loanId={c.loanId} currentCents={c.contractNote?.cents ?? null} /> : null}
            </CardContent>
          </Card>
          {c.state === "closed" ? (
            <Card size="sm">
              <CardHeader>
                <CardTitle>Closed</CardTitle>
                <CardDescription>
                  <LocalTime value={c.closedAt} format="date" />: {c.closeNote}
                </CardDescription>
              </CardHeader>
            </Card>
          ) : null}
        </div>
      </PageBody>
    </>
  );
}

