// AUDIT E — what the app shows vs the source records: phone cards and tablet agreements against the bank. Read-only.
// Each card/agreement is compared with the bank as it stood when it was pasted (rows after the paste are ignored).
import { sql } from "drizzle-orm";
import { stateAt } from "@/domain/health";
import { analyseLoan, contractSchedule, gameDueDates, INSTALMENT_ROLES, type LinkedPayment } from "@/domain/loans/analysis";
import type { LinkRole } from "@/domain/loans/link";
import { analyseMortgage, type MortgagePayment } from "@/domain/mortgages/schedule";
import { wholeDollars } from "@/lib/money";
import { SERVER_AGGREGATE } from "@/server/authz/rules";
import { db } from "@/server/db";
import { healthLoans } from "@/server/health";
import { listLoans } from "@/server/loans/queries";

const q = async <T extends Record<string, unknown>>(s: ReturnType<typeof sql>) => (await db.execute<T>(s)).rows;
const d = (c: number | null | undefined) => (c === null || c === undefined ? "—" : `$${(c / 100).toLocaleString("en-US")}`);
const h = (t: string) => console.log(`\n## ${t}`);
const DAY = 86_400_000;
const dt = <T extends Date | null>(v: T): T => (v === null ? v : (new Date(v as unknown as string) as T));

type Finding = { check: string; who: string; detail: string };
const findings: Finding[] = [];
const checked = new Map<string, number>();
const tick = (check: string) => checked.set(check, (checked.get(check) ?? 0) + 1);
const flag = (check: string, who: string, detail: string) => findings.push({ check, who, detail });

// ---------------------------------------------------------------- loans
const loans = await q<{
  id: string; who: string; sid: number; status: string; locked: boolean; principal: string; n: number | null; every: number | null; b: number | null; s: number | null;
  opened: Date | null; disb: string | null; disb_amount: string | null; first_default: Date | null; next_due: Date | null; last_completed: number | null; last_missed: number | null; last_tab: string | null;
}>(sql`
  select l.id, coalesce(l.borrower_name, 'State ID ' || l.borrower_state_id) || ' $' || (l.principal_cents / 100) as who, l.borrower_state_id as sid, l.status::text, l.status_locked as locked,
         l.principal_cents as principal, l.instalments as n, l.period_days as every, l.broker_rate_bp as b, l.state_rate_bp as s, l.opened_at as opened,
         l.disbursement_tx_id as disb, (select amount_cents from bank_transaction where id = l.disbursement_tx_id) as disb_amount,
         l.first_default_at as first_default, l.next_payment_due_at as next_due, l.last_completed, l.last_missed, l.last_card_tab::text as last_tab
    from loan l where l.retired_at is null`);
for (const l of loans) Object.assign(l, { opened: dt(l.opened), first_default: dt(l.first_default), next_due: dt(l.next_due) });
const links = await q<{ loan_id: string; tx: string; role: LinkRole; at: Date; amt: string; recovery: string | null }>(sql`
  select k.loan_id, b.id as tx, k.role, b.occurred_at as at, b.amount_cents as amt, k.recovery_entry_id as recovery
    from loan_payment_link k join bank_transaction b on b.id = k.bank_transaction_id order by b.occurred_at`);
for (const r of links) r.at = dt(r.at);
// firstSeen: when this exact text was first pasted. A countdown ("in 23 hours") counts from then — the same text pasted
// again later is an old copy (13 Oct 2026: 1 h 45 m apart).
const cards = await q<{ loan_id: string; tab: string; captured: Date; first_seen: Date; raw: string; parsed: Record<string, unknown> }>(sql`
  select distinct on (c.loan_id) c.loan_id, p.tab::text, p.captured_at as captured, c.raw, c.parsed,
    (select min(p2.captured_at) from loan_card c2 join loan_paste p2 on p2.id = c2.paste_id where c2.loan_id = c.loan_id and c2.raw = c.raw) as first_seen
    from loan_card c join loan_paste p on p.id = c.paste_id where c.loan_id is not null order by c.loan_id, p.captured_at desc, c.id desc`);
for (const c of cards) {
  c.captured = dt(c.captured);
  c.first_seen = dt(c.first_seen);
}
const cardOf = new Map(cards.map((c) => [c.loan_id, c]));
const linksOf = new Map<string, typeof links>();
for (const r of links) linksOf.set(r.loan_id, [...(linksOf.get(r.loan_id) ?? []), r]);

const TAB_STATUS: Record<string, string> = { active: "active", overdue: "overdue", default: "defaulted", complete: "completed" };
const num = (re: RegExp, raw: string) => {
  const m = re.exec(raw);
  return m ? Number(m[1].replace(/,/g, "")) : null;
};

h("E1 Loans: latest phone card vs the app (and vs the bank at the time of the paste)");
const remainingRatios: { who: string; tab: string; ratio: number; card: number; app: number; b: number; s: number }[] = [];
for (const l of loans) {
  const c = cardOf.get(l.id);
  if (!c) {
    tick("E1.0 loan has a card");
    if (l.status !== "completed" && l.status !== "written_off") flag("E1.0 loan has a card", l.who, `no phone card ever matched (status ${l.status})`);
    continue;
  }
  const raw = c.raw;
  const p = c.parsed as { headerAmountCents: number; completed: number | null; instalments: number | null; missedPayments: number | null; remainingCents: number | null; firstMissedAt: string | null; nextPaymentIn: { value: number; unit: string } | null; periodDays: number | null; principalCents: number | null; stateRatePct: number | null; brokerRatePct: number | null };

  // Parser vs raw text (independent regexes).
  tick("E1.1 parser reads the card");
  const rawPrincipal = num(/Loan Agreement Amount: \$([\d,]+)/, raw);
  const rawDone = /(\d+)\/(\d+) ?complete/.exec(raw);
  const rawRemaining = num(/\$([\d,.]+)\) remaining/, raw);
  const rawMissed = num(/Missed payment amounts (\d+)/, raw);
  if (rawPrincipal !== null && p.principalCents !== rawPrincipal * 100) flag("E1.1 parser reads the card", l.who, `principal raw $${rawPrincipal} parsed ${d(p.principalCents)}`);
  if (rawDone && (p.completed !== Number(rawDone[1]) || p.instalments !== Number(rawDone[2]))) flag("E1.1 parser reads the card", l.who, `n/N raw ${rawDone[0]} parsed ${p.completed}/${p.instalments}`);
  if (rawRemaining !== null && Math.abs((p.remainingCents ?? 0) - Math.round(rawRemaining) * 100) > 100) flag("E1.1 parser reads the card", l.who, `remaining raw ${rawRemaining} parsed ${d(p.remainingCents)}`);
  if (rawMissed !== null && p.missedPayments !== rawMissed) flag("E1.1 parser reads the card", l.who, `missed raw ${rawMissed} parsed ${p.missedPayments}`);

  // Terms.
  tick("E1.2 terms = card");
  // Early-version cards state the total repayable, P × (1 + broker rate) (CLAUDE.md), not the principal.
  const repayable = l.b === null ? null : Math.round((Number(l.principal) * (1 + l.b / 10_000)) / 100) * 100;
  if (p.principalCents !== null && p.principalCents !== Number(l.principal) && (repayable === null || Math.abs(p.principalCents - repayable) > 500))
    flag("E1.2 terms = card", l.who, `principal app ${d(Number(l.principal))} card ${d(p.principalCents)}`);
  if (l.disb_amount !== null && Number(l.disb_amount) !== Number(l.principal)) flag("E1.2 terms = card", l.who, `principal app ${d(Number(l.principal))} bank transfer ${d(Number(l.disb_amount))}`);
  if ((c.parsed as { stateId: number }).stateId !== l.sid) flag("E1.2 terms = card", l.who, `borrower State ID app ${l.sid} card ${(c.parsed as { stateId: number }).stateId}`);
  if (p.instalments !== null && l.n !== null && p.instalments !== l.n) flag("E1.2 terms = card", l.who, `instalments app ${l.n} card ${p.instalments}`);
  if (p.periodDays !== null && l.every !== null && p.periodDays !== l.every) flag("E1.2 terms = card", l.who, `period app ${l.every} card ${p.periodDays}`);
  if (p.brokerRatePct !== null && l.b !== null && Math.round(p.brokerRatePct * 100) !== l.b) flag("E1.2 terms = card", l.who, `broker rate app ${l.b / 100}% card ${p.brokerRatePct}%`);
  if (p.stateRatePct !== null && l.s !== null && Math.round(p.stateRatePct * 100) !== l.s) flag("E1.2 terms = card", l.who, `State rate app ${l.s / 100}% card ${p.stateRatePct}%`);

  // Status = the tab the card is in.
  tick("E1.3 status = phone tab");
  const expected = TAB_STATUS[c.tab];
  if (expected && l.status !== expected && !l.locked && l.status !== "written_off") flag("E1.3 status = phone tab", l.who, `app ${l.status}, latest card in ${c.tab} (${c.captured.toISOString().slice(0, 10)})`);

  if (!l.opened || l.n === null || l.b === null || l.s === null) continue;
  const terms = { principalCents: Number(l.principal), instalments: l.n, periodDays: l.every ?? 7, brokerRate: l.b / 10_000, stateRate: l.s / 10_000, openedAt: l.opened };
  const atPaste = (linksOf.get(l.id) ?? []).filter((r) => r.at <= c.captured && r.role !== "disbursement" && r.role !== "fee" && r.role !== "refund" && !r.recovery);
  const pays: LinkedPayment[] = atPaste.map((r) => ({ txId: r.tx, role: r.role, amountCents: Number(r.amt), occurredAt: r.at }));
  const a = analyseLoan(terms, pays);

  // Instalments paid: the card's n vs instalments (on time or late) in the bank by then.
  if (p.completed !== null && c.tab !== "complete") {
    tick("E1.4 instalments paid = card");
    if (a.instalmentsPaid !== p.completed) flag("E1.4 instalments paid = card", l.who, `card ${p.completed}/${p.instalments}, bank shows ${a.instalmentsPaid} instalment(s) by the paste (${c.tab})`);
  }

  // Remaining: compare with the app's outstanding principal at the paste.
  if (p.remainingCents !== null && c.tab !== "complete") {
    tick("E1.5 remaining = card");
    const app = a.outstandingCents;
    remainingRatios.push({ who: l.who, tab: c.tab, ratio: app ? p.remainingCents / app : NaN, card: p.remainingCents, app, b: l.b, s: l.s });
    // Active cards: the phone's remaining is the principal still owed — plus, once a payment was missed, the game's
    // +2% per missed payment on everything still to pay (booked as late fees when paid, owner 2026-10-13).
    const tolerance = Math.max(500, l.n * 100);
    if (c.tab === "active" && ![0, 1, 2, 3, 4].some((k) => Math.abs(p.remainingCents! - app * 1.02 ** k) <= tolerance))
      flag("E1.5 remaining = card", l.who, `card ${d(p.remainingCents)} remaining, app ${d(app)} still owed at the paste`);
  }

  // Next payment: the card's "in N days" from the paste vs the game's due date for the next instalment.
  if (p.nextPaymentIn && c.tab === "active") {
    tick("E1.6 next payment = card");
    const unit = { minutes: 60_000, hours: 3_600_000, days: DAY }[p.nextPaymentIn.unit] ?? DAY;
    const cardNext = c.first_seen.getTime() + p.nextPaymentIn.value * unit;
    const due = a.gameDueAt[Math.min(a.instalmentsPaid, l.n - 1)]?.getTime();
    // The card rounds down ("in 5 days" = 5 to 6 days).
    const late = due === undefined ? 0 : due - cardNext;
    if (due && (late < -3_600_000 || late > unit + 3_600_000)) flag("E1.6 next payment = card", l.who, `card says next ≈ ${new Date(cardNext).toISOString().slice(0, 16)}, game due date from the bank ${new Date(due).toISOString().slice(0, 16)}`);
    // The app's stored next payment (from the bank since 13 Oct) moves on with every payment after the paste.
    const paidSince = (linksOf.get(l.id) ?? []).some((k) => (k.role === "principal" || k.role === "late_principal") && k.at > c.captured);
    if (l.next_due && !paidSince && Math.abs(l.next_due.getTime() - cardNext) > unit && cardOf.get(l.id) === c) flag("E1.6 next payment = card", l.who, `app's next due ${l.next_due.toISOString().slice(0, 16)} vs card ≈ ${new Date(cardNext).toISOString().slice(0, 16)}`);
  }

  // First missed payment: the card's date vs the game's due date for the first instalment unpaid by then.
  if (p.firstMissedAt) {
    tick("E1.7 first missed = game due date");
    const fm = new Date(p.firstMissedAt);
    const paidBy = pays.filter((x) => INSTALMENT_ROLES.has(x.role) && x.occurredAt < fm).map((x) => x.occurredAt);
    const due = gameDueDates(terms, paidBy)[Math.min(paidBy.length, l.n - 1)];
    // The game charges a few minutes to an hour after the due time.
    const gap = fm.getTime() - due.getTime();
    if (gap < -120_000 || gap > 2 * 3_600_000) flag("E1.7 first missed = game due date", l.who, `card's first missed ${fm.toISOString().slice(0, 19)} is ${(gap / 3_600_000).toFixed(2)} h after the game due date ${due.toISOString().slice(0, 19)}`);
    if (l.status === "defaulted" && l.first_default) {
      // Third missed payment, or earlier when the phone already showed the loan in Default (the app can't date it later).
      const exp = fm.getTime() + 2 * (l.every ?? 7) * DAY;
      const ok = Math.abs(l.first_default.getTime() - exp) <= 120_000 || (l.first_default.getTime() < exp && l.first_default.getTime() >= fm.getTime());
      if (!ok) flag("E1.7 first missed = game due date", l.who, `default date ${l.first_default.toISOString().slice(0, 16)} vs card's first missed + 2 periods ${new Date(exp).toISOString().slice(0, 16)}`);
    }
  }

  // Missed count: card vs the game's due dates and the bank at the paste (Default cards keep counting).
  if (p.missedPayments !== null && c.tab !== "complete" && c.tab !== "default") {
    tick("E1.8 missed count = card");
    const due = a.gameDueAt.filter((x) => x.getTime() + 3_600_000 <= c.captured.getTime()).length;
    const behind = Math.max(0, due - a.instalmentsPaid);
    if (behind !== p.missedPayments) flag("E1.8 missed count = card", l.who, `card ${p.missedPayments} missed, game due dates vs bank ${behind} (${due} due, ${a.instalmentsPaid} paid) in ${c.tab}`);
  }

  // The amount on the card's header (the next payment) vs the contract instalment (+2% per missed payment, F5).
  if (c.tab === "active" && p.headerAmountCents > 0) {
    tick("E1.9 next amount = card");
    const row = contractSchedule(terms)[Math.min(a.instalmentsPaid, l.n - 1)];
    const contract = row.principalCents + (row.interestCharged ? row.interestCents : 0);
    const penalised = [0, 1, 2, 3].map((k) => wholeDollars(contract * 1.02 ** k));
    if (!penalised.some((x) => Math.abs(x - p.headerAmountCents) <= 200) && !a.flags.some((f) => f.kind === "early_overcharge" || f.kind === "interest_without_principal"))
      flag("E1.9 next amount = card", l.who, `card's next payment ${d(p.headerAmountCents)}, contract instalment ${d(contract)}`);
  }
}

// Portfolio health's state now vs the phone's tab.
{
  const listed = await listLoans(SERVER_AGGREGATE, { status: "all" });
  const now = new Date();
  for (const hl of await healthLoans(listed)) {
    const l = listed.find((x) => x.id === hl.id)!;
    if (l.status !== "active") continue;
    tick("E1.10 health agrees with the phone");
    const st = stateAt(hl, now);
    if (st !== "paying") flag("E1.10 health agrees with the phone", `${l.borrowerName} $${l.principalCents / 100}`, `phone: Active; Portfolio health says ${st}`);
  }
}

console.log("Remaining on the card vs the app's outstanding principal at the paste (ratio card/app):");
const byRatio = new Map<string, typeof remainingRatios>();
for (const r of remainingRatios) {
  const key = !Number.isFinite(r.ratio) ? "app 0" : Math.abs(r.ratio - 1) < 0.01 ? "≈ 1 (principal)" : Math.abs(r.ratio - (1 + (r.b - r.s) / 10_000)) < 0.01 ? "≈ 1+b−s" : Math.abs(r.ratio - (1 + r.b / 10_000)) < 0.01 ? "≈ 1+b" : "other";
  byRatio.set(`${r.tab} ${key}`, [...(byRatio.get(`${r.tab} ${key}`) ?? []), r]);
}
for (const [k, list] of [...byRatio].sort()) {
  console.log(`  ${k}: ${list.length}`);
  if (k.endsWith("other") || k.endsWith("app 0")) for (const r of list.slice(0, 12)) console.log(`     ${r.who}: card ${d(r.card)} app ${d(r.app)} ratio ${r.ratio.toFixed(4)} (b ${r.b / 100}% s ${r.s / 100}%)`);
}

// ---------------------------------------------------------------- mortgages
h("E2 Mortgages: latest tablet agreement vs the app (and vs the bank at the time of the paste)");
const morts = await q<{ id: string; who: string; status: string; funding: string; officer_sid: number | null; buyer_sid: number | null; price: string | null; down: string | null; loan: string | null; bi: string | null; fi: string | null; n: number | null; fee: string | null; originated: Date | null; grace: number | null }>(sql`
  select m.id, m.address || ' (' || coalesce(m.buyer_name, '?') || ')' as who, m.status::text, m.funding::text, m.officer_state_id as officer_sid, m.buyer_state_id as buyer_sid, m.price_cents as price, m.down_payment_cents as down, m.loan_cents as loan,
         m.broker_interest_cents as bi, m.federal_interest_cents as fi, m.instalments as n, m.broker_fee_cents as fee, m.originated_at as originated, m.grace_period_days as grace
    from mortgage m where m.merged_into_id is null`);
for (const m of morts) m.originated = dt(m.originated);
const snaps = await q<{ mortgage_id: string; captured: Date; parsed: Record<string, number | null> }>(sql`
  select distinct on (s.mortgage_id) s.mortgage_id, p.captured_at as captured, s.parsed
    from mortgage_snapshot s join mortgage_paste p on p.id = s.paste_id where s.mortgage_id is not null order by s.mortgage_id, p.captured_at desc, s.id desc`);
for (const x of snaps) x.captured = dt(x.captured);
const snapOf = new Map(snaps.map((s) => [s.mortgage_id, s]));
const mpays = await q<{ mortgage_id: string; tx: string; at: Date; gross: string; tax: string; to_state: string | null }>(sql`
  select mp.mortgage_id, b.id as tx, b.occurred_at as at, b.amount_cents as gross, b.tax_cents as tax,
         (select o.amount_cents from mortgage_settlement s join bank_transaction o on o.id = s.out_tx_id where s.in_tx_id = b.id and s.unwound_at is null limit 1) as to_state
    from mortgage_payment mp join bank_transaction b on b.id = mp.bank_transaction_id order by b.occurred_at`);
for (const r of mpays) r.at = dt(r.at);
const mpaysOf = new Map<string, MortgagePayment[]>();
for (const r of mpays) mpaysOf.set(r.mortgage_id, [...(mpaysOf.get(r.mortgage_id) ?? []), { txId: r.tx, occurredAt: r.at, grossCents: Number(r.gross), taxCents: Number(r.tax), toStateCents: r.to_state === null ? null : Number(r.to_state) }]);
const origin = await q<{ id: string; amount: string }>(sql`select m.id, b.amount_cents as amount from mortgage m join bank_transaction b on b.id = m.origination_tx_id where m.merged_into_id is null`);
const originOf = new Map(origin.map((o) => [o.id, Number(o.amount)]));

for (const m of morts) {
  const s = snapOf.get(m.id);
  if (!s) {
    tick("E2.0 mortgage has a tablet agreement");
    if (m.status === "active") flag("E2.0 mortgage has a tablet agreement", m.who, "never pasted from the tablet");
    continue;
  }
  const t = s.parsed;
  tick("E2.1 terms = tablet");
  const pairs: [string, string | number | null, number | null][] = [
    ["price", m.price, t.priceCents], ["down payment", m.down, t.downPaymentCents], ["loan", m.loan, t.loanCents], ["broker interest", m.bi, t.brokerInterestCents],
    ["federal interest", m.fi, t.federalInterestCents], ["instalments", m.n, t.instalments], ["broker fee", m.fee, t.brokerFeeCents],
  ];
  for (const [label, app, tab] of pairs) if (tab !== null && tab !== undefined && app !== null && Number(app) !== Number(tab)) flag("E2.1 terms = tablet", m.who, `${label} app ${app} tablet ${tab}`);
  const parties = s.parsed as unknown as { officer: { stateId: number | null } | null; buyer: { stateId: number | null } | null };
  tick("E2.7 officer and buyer = tablet");
  if (parties.officer?.stateId && m.officer_sid !== parties.officer.stateId) flag("E2.7 officer and buyer = tablet", m.who, `officer app #${m.officer_sid} tablet FINANCE #${parties.officer.stateId}`);
  if (parties.buyer?.stateId && m.buyer_sid !== parties.buyer.stateId) flag("E2.7 officer and buyer = tablet", m.who, `buyer app #${m.buyer_sid} tablet BUYER #${parties.buyer.stateId}`);

  const all = mpaysOf.get(m.id) ?? [];
  const before = all.filter((p) => p.occurredAt <= s.captured);
  tick("E2.2 payments = tablet's Paid count");
  if (t.paidCount !== null && t.paidCount !== undefined && before.length + 1 !== t.paidCount) flag("E2.2 payments = tablet's Paid count", m.who, `tablet "Paid ${t.paidCount}" (down payment + ${t.paidCount - 1}), bank shows ${before.length} repayment(s) by the paste ${s.captured.toISOString().slice(0, 16)}`);

  if (m.loan !== null && m.bi !== null && m.n && m.originated) {
    const a = analyseMortgage({ loanCents: Number(m.loan), brokerInterestCents: Number(m.bi), federalInterestCents: Number(m.fi ?? 0), instalments: m.n, originatedAt: m.originated, gracePeriodDays: m.grace ?? 7 }, before, s.captured);
    tick("E2.3 weekly amount = tablet");
    if (t.weeklyCents && Math.abs(a.schedule[0].totalCents - t.weeklyCents) > 100) flag("E2.3 weekly amount = tablet", m.who, `tablet weekly ${d(t.weeklyCents)}, app schedule ${d(a.schedule[0].totalCents)}`);
    tick("E2.4 remaining = tablet");
    const remaining = a.schedule.slice(a.paidCount).reduce((x, r) => x + r.totalCents, 0);
    if (t.remainingCents !== null && t.remainingCents !== undefined && Math.abs(remaining - t.remainingCents) > 100) flag("E2.4 remaining = tablet", m.who, `tablet remaining ${d(t.remainingCents)}, app schedule left ${d(remaining)} (${a.paidCount}/${m.n} paid)`);
    tick("E2.5 paid so far = tablet");
    // "Paid so far" = the "Down Payment & Fees" row + every repayment (gross) by the paste.
    const o = originOf.get(m.id);
    const paidSoFar = (o ?? 0) + before.reduce((x, r) => x + r.grossCents, 0);
    if (o !== undefined && t.paidSoFarCents !== null && t.paidSoFarCents !== undefined && Math.abs(paidSoFar - t.paidSoFarCents) > 100) flag("E2.5 paid so far = tablet", m.who, `tablet paid so far ${d(t.paidSoFarCents)}, bank down payment & fees + repayments ${d(paidSoFar)}`);
    tick("E2.6 repayment amounts = schedule");
    for (const x of a.matched) if (x.payment && x.differenceCents !== null && Math.abs(x.differenceCents) > 100) flag("E2.6 repayment amounts = schedule", m.who, `instalment ${x.instalment.number}: paid ${d(x.payment.grossCents)}, schedule ${d(x.instalment.totalCents)}`);
  }
}

// ---------------------------------------------------------------- history
h("E3 History events dated from a bank row");
for (const r of await q<{ what: string; who: string; event: Date; bank: Date }>(sql`
  select 'loan disbursed' as what, coalesce(l.borrower_name, '?') as who, e.at as event, b.occurred_at as bank
    from loan_event e join loan l on l.id = e.loan_id join bank_transaction b on b.id = l.disbursement_tx_id where e.kind = 'disbursed'
  union all
  select 'mortgage originated', m.address, e.at, b.occurred_at
    from mortgage_event e join mortgage m on m.id = e.mortgage_id join bank_transaction b on b.id = m.origination_tx_id where e.kind = 'originated'`)) {
  tick("E3 event time = bank row");
  if (new Date(r.event).getTime() !== new Date(r.bank).getTime()) flag("E3 event time = bank row", r.who, `${r.what} event at ${new Date(r.event).toISOString().slice(0, 19)}, bank row ${new Date(r.bank).toISOString().slice(0, 19)}`);
}

// ---------------------------------------------------------------- summary
h("Summary");
const byCheck = new Map<string, Finding[]>();
for (const f of findings) byCheck.set(f.check, [...(byCheck.get(f.check) ?? []), f]);
for (const check of [...new Set([...checked.keys(), ...byCheck.keys()])].sort()) {
  const list = byCheck.get(check) ?? [];
  console.log(`${check}: ${checked.get(check) ?? "(within E1.5)"} checked, ${list.length} mismatch(es)`);
  for (const f of list.slice(0, 15)) console.log(`   ${f.who}: ${f.detail}`);
  if (list.length > 15) console.log(`   … ${list.length - 15} more`);
}
process.exit(0);
