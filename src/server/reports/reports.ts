import "server-only";
import { dateFormat } from "@/lib/dates";
import { and, asc, desc, gte, isNull, lt, sql } from "drizzle-orm";
import { monthPeriod, zonedMidnight, zonedParts } from "@/lib/company-time";
import { db } from "@/server/db";
import { bankTransaction, mortgage, staff } from "@/server/db/schema";
import { profitAndLoss, trialBalance } from "@/server/ledger/queries";
import { listLoans } from "@/server/loans/queries";
import { listMortgages } from "@/server/mortgages/queries";
import { collectionRate, rollMovement, snapshot, stateAt, type LoanState } from "@/domain/health";
import { shiftWeek, weekKeyOf, weekRange } from "@/domain/commissions/week";
import { healthLoans } from "@/server/health";
import { loanProfits, mortgageProfits } from "@/server/profit";
import { expectedLosses } from "@/server/risk";
import type { Viewer } from "@/server/authz/viewer";

/**
 * Finance reports (docs/research/09). Each report is a list of plain tables so
 * the same data drives the page and the Excel download. Money is integer cents.
 */

export const REPORTS = ["pnl", "balance", "book", "portfolio", "health", "tax"] as const;
export type ReportKey = (typeof REPORTS)[number];

export const REPORT_TITLES: Record<ReportKey, string> = {
  pnl: "Profit & loss",
  balance: "Balance sheet",
  book: "Loan & mortgage book",
  portfolio: "Loan performance",
  health: "Portfolio health",
  tax: "Tax & commissions",
};

export type Cell = string | number | Date | null;
export type Column = { key: string; label: string; kind: "text" | "money" | "date" | "number" | "percent" };
export type ReportTable = { title: string; note?: string; columns: Column[]; rows: Record<string, Cell>[]; total?: Record<string, Cell> };
export type Report = { key: ReportKey; title: string; subtitle: string; tables: ReportTable[] };

export type Range = { from: Date; to: Date; fromKey: string; toKey: string };

const pad = (n: number) => String(n).padStart(2, "0");
const dateKey = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** London calendar dates (inclusive) → [from, to) instants. Defaults: 1 Jan this year → today. */
export function parseRange(fromKey: string | undefined, toKey: string | undefined, now: Date = new Date()): Range {
  const today = zonedParts(now);
  const valid = (k: string | undefined) => (k && /^\d{4}-\d{2}-\d{2}$/.test(k) && !Number.isNaN(Date.parse(k)) ? k : undefined);
  const f = valid(fromKey) ?? dateKey(today.year, 1, 1);
  let t = valid(toKey) ?? dateKey(today.year, today.month, today.day);
  if (t < f) t = f;
  const [fy, fm, fd] = f.split("-").map(Number);
  const [ty, tm, td] = t.split("-").map(Number);
  const next = new Date(Date.UTC(ty, tm - 1, td + 1));
  return { from: zonedMidnight(fy, fm, fd), to: zonedMidnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()), fromKey: f, toKey: t };
}

export function rangeLabel(r: Range): string {
  const f = dateFormat({ day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return `${f.format(Date.parse(r.fromKey))} – ${f.format(Date.parse(r.toKey))}`;
}

/** Calendar months touching the range (at most 24). */
function monthsIn(r: Range) {
  const start = zonedParts(r.from);
  const end = zonedParts(new Date(r.to.getTime() - 1));
  const out = [];
  let y = start.year;
  let m = start.month;
  while ((y < end.year || (y === end.year && m <= end.month)) && out.length < 24) {
    out.push(monthPeriod(y, m));
    if (m === 12) {
      m = 1;
      y++;
    } else m++;
  }
  return out;
}

async function pnl(r: Range): Promise<Report> {
  const months = monthsIn(r);
  const clip = (p: { from: Date; to: Date }) => ({ from: p.from < r.from ? r.from : p.from, to: p.to > r.to ? r.to : p.to });
  const span = r.to.getTime() - r.from.getTime();
  const [perMonth, total, previous] = await Promise.all([
    Promise.all(months.map((m) => profitAndLoss(clip(m).from, clip(m).to))),
    profitAndLoss(r.from, r.to),
    profitAndLoss(new Date(r.from.getTime() - span), r.from),
  ]);
  const accounts = new Map<string, { name: string; type: "income" | "expense" }>();
  for (const p of [total, previous, ...perMonth]) for (const l of p.lines) accounts.set(l.code, { name: l.name, type: l.type });
  const amount = (p: typeof total, code: string) => p.lines.find((l) => l.code === code)?.amountCents ?? 0;
  const columns: Column[] = [
    { key: "account", label: "Account", kind: "text" },
    ...months.map((m) => ({ key: m.key, label: m.label, kind: "money" as const })),
    { key: "total", label: "Total", kind: "money" },
    { key: "previous", label: "Previous period", kind: "money" },
  ];
  const section = (type: "income" | "expense", title: string): ReportTable => {
    const codes = [...accounts].filter(([, a]) => a.type === type).map(([c]) => c).sort();
    const rows = codes.map((code) => ({
      account: `${code} ${accounts.get(code)!.name}`,
      ...Object.fromEntries(months.map((m, i) => [m.key, amount(perMonth[i], code)])),
      total: amount(total, code),
      previous: amount(previous, code),
    }));
    const key = type === "income" ? "incomeCents" : "expenseCents";
    return {
      title,
      columns,
      rows,
      total: { account: `Total ${title.toLowerCase()}`, ...Object.fromEntries(months.map((m, i) => [m.key, perMonth[i][key]])), total: total[key], previous: previous[key] },
    };
  };
  return {
    key: "pnl",
    title: REPORT_TITLES.pnl,
    subtitle: rangeLabel(r),
    tables: [
      section("income", "Income"),
      section("expense", "Expenses"),
      {
        title: "Net profit",
        note: "Tax withheld at source is shown as an expense (5200). The previous period is the same length immediately before.",
        columns,
        rows: [{ account: "Net profit", ...Object.fromEntries(months.map((m, i) => [m.key, perMonth[i].netCents])), total: total.netCents, previous: previous.netCents }],
      },
    ],
  };
}

async function balance(r: Range): Promise<Report> {
  const tb = await trialBalance({ before: r.to });
  const rows = (type: string) => tb.filter((a) => a.type === type && a.balanceCents !== 0).map((a) => ({ account: `${a.code} ${a.name}`, amount: a.balanceCents }));
  const sum = (type: string) => tb.filter((a) => a.type === type).reduce((s, a) => s + a.balanceCents, 0);
  const profit = sum("income") - sum("expense");
  const cols: Column[] = [
    { key: "account", label: "Account", kind: "text" },
    { key: "amount", label: "Amount", kind: "money" },
  ];
  return {
    key: "balance",
    title: REPORT_TITLES.balance,
    subtitle: `As at the end of ${rangeLabel(r).split(" – ")[1]}`,
    tables: [
      { title: "What the company has", columns: cols, rows: rows("asset"), total: { account: "Total assets", amount: sum("asset") } },
      { title: "What the company owes", columns: cols, rows: rows("liability"), total: { account: "Total liabilities", amount: sum("liability") } },
      {
        title: "Owners' equity",
        note: "Assets = liabilities + equity. Profit to date is every period's income less expenses since the books began.",
        columns: cols,
        rows: [...rows("equity"), { account: "Profit to date (retained)", amount: profit }],
        total: { account: "Total equity", amount: sum("equity") + profit },
      },
    ],
  };
}

async function book(viewer: Viewer, r: Range): Promise<Report> {
  const loans = (await listLoans(viewer, { status: "all" })).filter((l) => !l.openedAt || (l.openedAt >= r.from && l.openedAt < r.to));
  const mortgages = await db
    .select({
      address: mortgage.address,
      buyer: mortgage.buyerName,
      buyerId: mortgage.buyerStateId,
      funding: mortgage.funding,
      started: mortgage.originatedAt,
      price: mortgage.priceCents,
      loan: mortgage.loanCents,
      fee: mortgage.brokerFeeCents,
      instalments: mortgage.instalments,
      status: mortgage.status,
      officer: staff.characterName,
      paid: sql<number>`(select count(*)::int from mortgage_payment p where p.mortgage_id = ${mortgage.id})`,
    })
    .from(mortgage)
    .leftJoin(staff, sql`${staff.id} = ${mortgage.officerStaffId}`)
    .where(and(isNull(mortgage.mergedIntoId), gte(mortgage.originatedAt, r.from), lt(mortgage.originatedAt, r.to)))
    .orderBy(desc(mortgage.originatedAt));
  const sum = (xs: (number | null)[]) => xs.reduce<number>((s, x) => s + (x ?? 0), 0);
  return {
    key: "book",
    title: REPORT_TITLES.book,
    subtitle: `Started ${rangeLabel(r)}`,
    tables: [
      {
        title: `Loans (${loans.length})`,
        columns: [
          { key: "borrower", label: "Borrower", kind: "text" },
          { key: "stateId", label: "State ID", kind: "number" },
          { key: "opened", label: "Opened", kind: "date" },
          { key: "status", label: "Status", kind: "text" },
          { key: "officer", label: "Officer", kind: "text" },
          { key: "principal", label: "Principal", kind: "money" },
          { key: "repaid", label: "Principal repaid", kind: "money" },
          { key: "interest", label: "Interest received", kind: "money" },
          { key: "outstanding", label: "Outstanding", kind: "money" },
        ],
        rows: loans.map((l) => ({
          borrower: l.borrowerName ?? "",
          stateId: l.borrowerStateId,
          opened: l.openedAt,
          status: l.status.replace("_", " "),
          officer: l.officerName ?? "",
          principal: l.principalCents,
          repaid: l.principalReceivedCents,
          interest: l.interestReceivedCents,
          outstanding: l.outstandingCents,
        })),
        total: {
          borrower: "Total",
          principal: sum(loans.map((l) => l.principalCents)),
          repaid: sum(loans.map((l) => l.principalReceivedCents)),
          interest: sum(loans.map((l) => l.interestReceivedCents)),
          outstanding: sum(loans.map((l) => l.outstandingCents)),
        },
      },
      {
        title: `Mortgages (${mortgages.length})`,
        columns: [
          { key: "address", label: "Property", kind: "text" },
          { key: "buyer", label: "Buyer", kind: "text" },
          { key: "started", label: "Started", kind: "date" },
          { key: "funding", label: "Funded by", kind: "text" },
          { key: "officer", label: "Officer", kind: "text" },
          { key: "price", label: "Price", kind: "money" },
          { key: "loan", label: "Loan", kind: "money" },
          { key: "fee", label: "Banker fee", kind: "money" },
          { key: "paid", label: "Payments made", kind: "text" },
          { key: "status", label: "Status", kind: "text" },
        ],
        rows: mortgages.map((m) => ({
          address: m.address,
          buyer: `${m.buyer ?? ""}${m.buyerId ? ` #${m.buyerId}` : ""}`,
          started: m.started,
          funding: m.funding === "company" ? "Litt's" : "State",
          officer: m.officer ?? "",
          price: m.price,
          loan: m.loan,
          fee: m.fee,
          paid: m.instalments ? `${m.paid}/${m.instalments}` : String(m.paid),
          status: m.status,
        })),
        total: { address: "Total", price: sum(mortgages.map((m) => m.price)), loan: sum(mortgages.map((m) => m.loan)), fee: sum(mortgages.map((m) => m.fee)) },
      },
    ],
  };
}

async function tax(r: Range): Promise<Report> {
  const months = await db.execute<{ month: string; withheld: string; recorded: string }>(sql`
    select to_char(date_trunc('month', occurred_at at time zone 'Europe/London'), 'YYYY-MM') as month,
      sum(case when direction = 'in' then tax_cents else 0 end) as withheld,
      sum(case when category = 'tax.remittance_record' then amount_cents else 0 end) as recorded
    from bank_transaction where occurred_at >= ${r.from} and occurred_at < ${r.to}
    group by 1 order by 1`);
  const commission = await db.execute<{ name: string; earned: string; paid: string }>(sql`
    select s.character_name as name,
      coalesce((select sum(a.amount_cents) from commission_award a join commission_week w on w.id = a.week_id
                where a.staff_id = s.id and w.closed_at is not null and (w.week_key)::date >= ${r.fromKey}::date and (w.week_key)::date <= ${r.toKey}::date), 0) as earned,
      coalesce((select sum(b.amount_cents) from commission_payout p join bank_transaction b on b.id = p.bank_transaction_id
                where p.staff_id = s.id and p.status = 'matched' and b.occurred_at >= ${r.from} and b.occurred_at < ${r.to}), 0) as paid
    from staff s order by s.character_name`);
  const oldScheme = await db
    .select({ total: sql<string>`coalesce(sum(${bankTransaction.amountCents}), 0)` })
    .from(bankTransaction)
    .where(and(sql`${bankTransaction.category} = 'commission'`, gte(bankTransaction.occurredAt, r.from), lt(bankTransaction.occurredAt, r.to), sql`not exists (select 1 from commission_payout p where p.bank_transaction_id = ${bankTransaction.id} and p.status = 'matched')`));
  const people = commission.rows.filter((c) => Number(c.earned) || Number(c.paid));
  const monthLabel = (k: string) => new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(Date.parse(`${k}-01`));
  return {
    key: "tax",
    title: REPORT_TITLES.tax,
    subtitle: rangeLabel(r),
    tables: [
      {
        title: "Tax withheld at source",
        note: "The bank withholds tax on money received; the State posts a matching “Tax Payment” record early the next month. The business account never pays it.",
        columns: [
          { key: "month", label: "Month (UK)", kind: "text" },
          { key: "withheld", label: "Withheld", kind: "money" },
          { key: "recorded", label: "Tax Payment record", kind: "money" },
        ],
        rows: months.rows.map((m) => ({ month: monthLabel(m.month), withheld: Number(m.withheld), recorded: Number(m.recorded) })),
        total: { month: "Total", withheld: months.rows.reduce((s, m) => s + Number(m.withheld), 0), recorded: months.rows.reduce((s, m) => s + Number(m.recorded), 0) },
      },
      {
        title: "Commission (scheme from 12 Oct 2026)",
        note: "Earned = weeks closed in the period. Paid = payouts matched to the person in the period.",
        columns: [
          { key: "name", label: "Person", kind: "text" },
          { key: "earned", label: "Earned", kind: "money" },
          { key: "paid", label: "Paid", kind: "money" },
        ],
        rows: people.map((c) => ({ name: c.name, earned: Number(c.earned), paid: Number(c.paid) })),
        total: { name: "Total", earned: people.reduce((s, c) => s + Number(c.earned), 0), paid: people.reduce((s, c) => s + Number(c.paid), 0) },
      },
      {
        title: "Other commission paid",
        note: "Commission payments not matched to the scheme (the old scheme, or not yet assigned).",
        columns: [
          { key: "label", label: "", kind: "text" },
          { key: "amount", label: "Amount", kind: "money" },
        ],
        rows: [{ label: "Paid in the period", amount: Number(oldScheme[0]?.total ?? 0) }],
      },
    ],
  };
}

/**
 * How loans opened in the period have gone (research/11–12): by size, rate, officer and
 * month opened, with what each has made for Litt's ("net", from the books, before
 * commission); then concentration, borrowers, mortgages by officer, and the best and
 * worst loans. "Went bad" = defaulted or written off; the rate is of finished loans.
 */
async function portfolio(viewer: Viewer, r: Range): Promise<Report> {
  const [all, profits, mortgages, mortgageNet] = await Promise.all([listLoans(viewer, { status: "all" }), loanProfits(), listMortgages(viewer, { status: "all" }), mortgageProfits()]);
  const loans = all.filter((l) => l.openedAt && l.openedAt >= r.from && l.openedAt < r.to);
  type L = (typeof loans)[number];
  const net = (l: L) => profits.get(l.id) ?? 0;
  const owed = (l: L) => (l.status === "active" || l.status === "overdue" || l.status === "defaulted" ? Math.max(0, l.outstandingCents ?? 0) : 0);
  const bad = (l: L) => l.status === "defaulted" || l.status === "written_off";
  const finished = (l: L) => l.status !== "active" && l.status !== "overdue";
  const group = (label: string, list: L[]): Record<string, Cell> => {
    const done = list.filter(finished);
    const went = list.filter(bad);
    return {
      group: label,
      loans: list.length,
      lent: list.reduce((s, l) => s + l.principalCents, 0),
      running: list.length - done.length,
      repaid: done.length - went.length,
      bad: went.length,
      badRate: done.length ? went.length / done.length : null,
      interest: list.reduce((s, l) => s + l.interestReceivedCents, 0),
      unrecovered: went.reduce((s, l) => s + Math.max(0, l.principalCents - l.principalReceivedCents), 0),
      net: list.reduce((s, l) => s + net(l), 0),
    };
  };
  const columns: Column[] = [
    { key: "group", label: "", kind: "text" },
    { key: "loans", label: "Loans", kind: "number" },
    { key: "lent", label: "Lent", kind: "money" },
    { key: "running", label: "Running", kind: "number" },
    { key: "repaid", label: "Repaid", kind: "number" },
    { key: "bad", label: "Went bad", kind: "number" },
    { key: "badRate", label: "Bad rate", kind: "percent" },
    { key: "interest", label: "Interest received", kind: "money" },
    { key: "unrecovered", label: "Principal not recovered", kind: "money" },
    { key: "net", label: "Net to Litt’s", kind: "money" },
  ];
  const bands = <T,>(of: (l: L) => T | null, order: T[], label: (t: T) => string) =>
    order.map((b) => group(label(b), loans.filter((l) => of(l) === b))).filter((row) => Number(row.loans) > 0);
  const size = (l: L) => (l.principalCents < 2_500_000 ? 0 : l.principalCents < 7_500_000 ? 1 : 2);
  const rate = (l: L) => (l.brokerRateBp === null ? null : l.brokerRateBp < 1500 ? 0 : l.brokerRateBp < 2000 ? 1 : 2);
  const officers = [...new Set(loans.map((l) => l.officerName ?? "No officer"))].sort();
  const months = [...new Set(loans.map((l) => monthKey(l.openedAt!)))].sort().reverse();
  const note =
    "Went bad = defaulted or written off. Bad rate is of finished loans (repaid or gone bad). Net to Litt’s is from the books: interest and fees after tax, less the State levy, closing differences and write-offs, plus recoveries, before commission.";

  // Borrowers with loans opened in the period.
  const byBorrower = new Map<number, L[]>();
  for (const l of loans) byBorrower.set(l.borrowerStateId, [...(byBorrower.get(l.borrowerStateId) ?? []), l]);
  const borrowerRows = [...byBorrower]
    .map(([stateId, list]): Record<string, Cell> => ({ ...group(`${list.find((l) => l.borrowerName)?.borrowerName ?? "Unknown"} #${stateId}`, list), owed: list.reduce((s, l) => s + owed(l), 0) }))
    .sort((a, b) => Number(b.lent) - Number(a.lent));

  // Concentration: today's whole book, whatever the period.
  const bookNow = all.reduce((s, l) => s + owed(l), 0);
  const owedBy = new Map<number, { name: string; owed: number }>();
  for (const l of all) {
    if (!owed(l)) continue;
    const e = owedBy.get(l.borrowerStateId) ?? { name: l.borrowerName ?? "Unknown", owed: 0 };
    e.owed += owed(l);
    owedBy.set(l.borrowerStateId, e);
  }
  const largest = [...owedBy].sort((a, b) => b[1].owed - a[1].owed);
  const top5 = largest.slice(0, 5).reduce((s, [, e]) => s + e.owed, 0);
  const share = (c: number) => (bookNow ? c / bookNow : null);

  const mortgagesIn = mortgages.filter((m) => m.originatedAt && m.originatedAt >= r.from && m.originatedAt < r.to);
  const mortgageOfficers = [...new Set(mortgagesIn.map((m) => m.officerName ?? "No officer"))].sort();
  const mNet = (list: typeof mortgagesIn) => list.reduce((s, m) => s + (mortgageNet.get(m.id) ?? 0), 0);
  const ranked = loans.filter(finished).sort((a, b) => net(b) - net(a));
  const best = ranked.slice(0, Math.min(10, Math.ceil(ranked.length / 2)));
  const worst = ranked.slice(best.length).slice(-10).reverse();
  const loanRow = (l: L) => ({ borrower: `${l.borrowerName ?? "Unknown"} #${l.borrowerStateId}`, opened: l.openedAt, status: l.status.replace("_", " "), officer: l.officerName ?? "", lent: l.principalCents, net: net(l) });
  const loanColumns: Column[] = [
    { key: "borrower", label: "Borrower", kind: "text" },
    { key: "opened", label: "Opened", kind: "date" },
    { key: "status", label: "Status", kind: "text" },
    { key: "officer", label: "Officer", kind: "text" },
    { key: "lent", label: "Lent", kind: "money" },
    { key: "net", label: "Net to Litt’s", kind: "money" },
  ];

  return {
    key: "portfolio",
    title: REPORT_TITLES.portfolio,
    subtitle: `Loans and mortgages started ${rangeLabel(r)}`,
    tables: [
      { title: "Overall", note, columns, rows: [group("All loans", loans)] },
      { title: "By size", columns, rows: bands(size, [0, 1, 2], (b) => ["Under $25,000", "$25,000–$74,999", "$75,000 or more"][b]) },
      { title: "By rate", columns, rows: bands(rate, [0, 1, 2], (b) => ["Under 15%", "15–19.9%", "20% or more"][b]) },
      { title: "By officer", columns, rows: officers.map((o) => group(o, loans.filter((l) => (l.officerName ?? "No officer") === o))) },
      { title: "By month opened", columns, rows: months.map((m) => group(m, loans.filter((l) => monthKey(l.openedAt!) === m))) },
      {
        title: "Concentration",
        note: "How much of what’s owed to Litt’s today (all loans, defaulted included) sits with the biggest borrowers. The more in a few hands, the more one default hurts.",
        columns: [
          { key: "label", label: "", kind: "text" },
          { key: "owed", label: "Owed", kind: "money" },
          { key: "share", label: "Share of the book", kind: "percent" },
        ],
        rows: [
          ...largest.slice(0, 5).map(([stateId, e], i) => ({ label: `${i + 1}. ${e.name} #${stateId}`, owed: e.owed, share: share(e.owed) })),
          { label: "Top 5 together", owed: top5, share: share(top5) },
        ],
        total: { label: `All ${owedBy.size} borrowers who owe`, owed: bookNow, share: share(bookNow) },
      },
      {
        title: "By borrower",
        note: "Borrowers with loans opened in the period, most lent first. Owed now is what they still owe on those loans.",
        columns: [...columns, { key: "owed", label: "Owed now", kind: "money" }],
        rows: borrowerRows,
      },
      {
        title: "Mortgages by officer",
        note: "Mortgages started in the period. Net to Litt’s: the banker fee and broker interest kept so far, from the books.",
        columns: [
          { key: "group", label: "", kind: "text" },
          { key: "count", label: "Mortgages", kind: "number" },
          { key: "loan", label: "Loans arranged", kind: "money" },
          { key: "behind", label: "Late or behind now", kind: "number" },
          { key: "net", label: "Net to Litt’s", kind: "money" },
        ],
        rows: mortgageOfficers.map((o) => {
          const list = mortgagesIn.filter((m) => (m.officerName ?? "No officer") === o);
          return {
            group: o,
            count: list.length,
            loan: list.reduce((s, m) => s + (m.loanCents ?? 0), 0),
            behind: list.filter((m) => m.status === "active" && (m.state?.kind === "late" || m.state?.kind === "behind")).length,
            net: mNet(list),
          };
        }),
        total: { group: "All", count: mortgagesIn.length, loan: mortgagesIn.reduce((s, m) => s + (m.loanCents ?? 0), 0), net: mNet(mortgagesIn) },
      },
      { title: "Best finished loans", note: "Finished loans opened in the period that made Litt’s the most.", columns: loanColumns, rows: best.map(loanRow) },
      { title: "Worst finished loans", note: "And the least, losses first.", columns: loanColumns, rows: worst.map(loanRow) },
    ],
  };
}

/**
 * Portfolio health (research/12) as at the end of the range: what's at risk, how
 * loans moved week to week, collected vs due, how each month's lending has done,
 * and expected losses. History is rebuilt from the contract and the bank
 * (domain/health.ts).
 */
async function health(viewer: Viewer, r: Range): Promise<Report> {
  const asAt = r.to < new Date() ? r.to : new Date();
  const [loans, mortgages, losses] = await Promise.all([listLoans(viewer, { status: "all" }), listMortgages(viewer, { status: "active" }), expectedLosses()]);
  const hl = await healthLoans(loans);
  const WEEKS = 12;
  const current = weekKeyOf(asAt);
  const weeks = Array.from({ length: WEEKS }, (_, i) => weekRange(shiftWeek(current, i - WEEKS + 1))).map((w) => ({ from: w.from, to: w.to > asAt ? asAt : w.to }));
  const moments = [...weeks.map((w) => w.from), weeks[WEEKS - 1].to];
  const now = snapshot(hl, asAt);
  const totalOwed = now.owed.paying + now.owed.behind + now.owed.defaulted;
  const STATE_LABEL: Record<LoanState, string> = { paying: "Paying", behind: "Behind", defaulted: "Defaulted", repaid: "Repaid", written_off: "Written off" };
  const day = dateFormat({ day: "numeric", month: "short", timeZone: "Europe/London" });
  const roll = rollMovement(hl, moments);
  const rollTotal = (from: "paying" | "behind" | "defaulted") => Object.values(roll[from]).reduce((s, n) => s + n, 0);
  const worse = { paying: roll.paying.behind + roll.paying.defaulted + roll.paying.written_off, behind: roll.behind.defaulted + roll.behind.written_off, defaulted: roll.defaulted.written_off };

  const vintages = new Map<string, typeof hl>();
  for (const l of hl) vintages.set(monthKey(l.openedAt), [...(vintages.get(monthKey(l.openedAt)) ?? []), l]);
  const lateMortgages = mortgages.filter((m) => m.state?.kind === "late" || m.state?.kind === "behind");

  return {
    key: "health",
    title: REPORT_TITLES.health,
    subtitle: `As at ${dateFormat({ day: "numeric", month: "short", year: "numeric", timeZone: "Europe/London" }).format(new Date(asAt.getTime() - 1))}`,
    tables: [
      {
        title: "At risk now",
        note: "Behind = an instalment more than a day late by the contract schedule, worked out from the bank (the phone’s Overdue tab can differ by a few days). At risk = behind or defaulted.",
        columns: [
          { key: "state", label: "", kind: "text" },
          { key: "loans", label: "Loans", kind: "number" },
          { key: "owed", label: "Owed", kind: "money" },
          { key: "share", label: "Share", kind: "percent" },
        ],
        rows: (["paying", "behind", "defaulted"] as const).map((k) => ({ state: STATE_LABEL[k], loans: now.count[k], owed: now.owed[k], share: totalOwed ? now.owed[k] / totalOwed : null })),
        total: { state: `At risk: ${Math.round(now.atRiskShare * 100)}% of what’s owed`, loans: now.count.paying + now.count.behind + now.count.defaulted, owed: totalOwed, share: totalOwed ? 1 : null },
      },
      {
        title: "Week by week",
        note: "Collected = everything borrowers paid in the week; due = instalments scheduled that week on loans still being repaid. Over 100% means people catching up or paying early.",
        columns: [
          { key: "week", label: "Week", kind: "text" },
          { key: "paying", label: "Paying", kind: "number" },
          { key: "behind", label: "Behind", kind: "number" },
          { key: "defaulted", label: "Defaulted", kind: "number" },
          { key: "owed", label: "Owed", kind: "money" },
          { key: "atRisk", label: "At risk", kind: "percent" },
          { key: "due", label: "Due", kind: "money" },
          { key: "collected", label: "Collected", kind: "money" },
          { key: "rate", label: "Collection rate", kind: "percent" },
        ],
        rows: weeks
          .map((w) => {
            const s = snapshot(hl, w.to);
            const c = collectionRate(hl, w.from, w.to);
            return {
              week: `${day.format(w.from)} – ${day.format(new Date(w.to.getTime() - 1))}`,
              paying: s.count.paying,
              behind: s.count.behind,
              defaulted: s.count.defaulted,
              owed: s.owed.paying + s.owed.behind + s.owed.defaulted,
              atRisk: s.atRiskShare,
              due: c.dueCents,
              collected: c.collectedCents,
              rate: c.rate,
            };
          })
          .reverse(),
      },
      {
        title: `Movement over the last ${WEEKS} weeks`,
        note: "Every loan, every week: where it was at the start of the week (rows) and at the end (columns). Read across: for example, how many loans that were paying fell behind.",
        columns: [
          { key: "from", label: "At the start", kind: "text" },
          ...(Object.keys(STATE_LABEL) as LoanState[]).map((k) => ({ key: k, label: STATE_LABEL[k], kind: "number" as const })),
          { key: "worse", label: "Got worse", kind: "percent" },
        ],
        rows: (["paying", "behind", "defaulted"] as const).map((from) => ({ from: STATE_LABEL[from], ...roll[from], worse: rollTotal(from) ? worse[from] / rollTotal(from) : null })),
      },
      {
        title: "By month lent",
        note: "Each month’s loans and how they’ve done so far. Paid back counts everything borrowers have paid (principal and interest, before tax) against what was lent.",
        columns: [
          { key: "month", label: "Month", kind: "text" },
          { key: "loans", label: "Loans", kind: "number" },
          { key: "lent", label: "Lent", kind: "money" },
          { key: "paidBack", label: "Paid back", kind: "money" },
          { key: "returned", label: "Paid back %", kind: "percent" },
          { key: "running", label: "Running", kind: "number" },
          { key: "bad", label: "Went bad", kind: "number" },
          { key: "badShare", label: "Went bad %", kind: "percent" },
        ],
        rows: [...vintages]
          .sort((a, b) => b[0].localeCompare(a[0]))
          .map(([month, list]) => {
            const lent = list.reduce((s, l) => s + l.principalCents, 0);
            const paidBack = list.reduce((s, l) => s + l.payments.filter((p) => p.at < asAt).reduce((t, p) => t + p.grossCents, 0), 0);
            const states = list.map((l) => stateAt(l, asAt));
            const bad = states.filter((s) => s === "defaulted" || s === "written_off").length;
            return { month, loans: list.length, lent, paidBack, returned: lent ? paidBack / lent : null, running: states.filter((s) => s === "paying" || s === "behind").length, bad, badShare: list.length ? bad / list.length : null };
          }),
      },
      {
        title: "Expected losses",
        note: `Loss rates from Litt’s own history (see Basis), times the share of a bad debt never recovered (${Math.round(losses.rates.lossGivenDefault * 100)}%: of what loans that went bad owed when they defaulted, the part never paid back). Includes company-funded mortgages. A figure only; nothing is booked. Always today’s figures.`,
        columns: [
          { key: "bucket", label: "", kind: "text" },
          { key: "count", label: "Loans", kind: "number" },
          { key: "owed", label: "Owed", kind: "money" },
          { key: "rate", label: "Loss rate", kind: "percent" },
          { key: "basis", label: "Basis", kind: "text" },
          { key: "expected", label: "Expected loss", kind: "money" },
        ],
        rows: [
          ...losses.buckets.map((b) => {
            const rt = losses.rates[b.bucket];
            return {
              bucket: b.label,
              count: b.count,
              owed: b.owedCents,
              rate: rt.rate * losses.rates.lossGivenDefault,
              basis: rt.borrowed ? `Only ${rt.of} past cases, so the rate above is used` : `${rt.bad} of ${rt.of} past cases went bad`,
              expected: b.expectedCents,
            };
          }),
          { bucket: "Realistic book value", owed: losses.realisticCents, basis: "Owed less expected losses" },
        ],
        total: { bucket: "Total", count: losses.buckets.reduce((s, b) => s + b.count, 0), owed: losses.owedCents, expected: losses.expectedCents },
      },
      {
        title: "Mortgages late or behind",
        note: "Mortgage instalments go to the State; Litt’s broker interest stops while a buyer is behind.",
        columns: [
          { key: "address", label: "Property", kind: "text" },
          { key: "buyer", label: "Buyer", kind: "text" },
          { key: "state", label: "State", kind: "text" },
          { key: "missed", label: "Missed", kind: "number" },
        ],
        rows: lateMortgages.map((m) => ({
          address: m.address,
          buyer: `${m.buyerName ?? ""}${m.buyerStateId ? ` #${m.buyerStateId}` : ""}`,
          state: m.state?.kind === "late" ? "Late · in grace" : "Behind",
          missed: m.state?.kind === "late" || m.state?.kind === "behind" ? m.state.overdue : null,
        })),
      },
    ],
  };
}

function monthKey(d: Date): string {
  const { year, month } = zonedParts(d);
  return `${year}-${String(month).padStart(2, "0")}`;
}

export async function buildReport(viewer: Viewer, key: ReportKey, r: Range): Promise<Report> {
  switch (key) {
    case "pnl":
      return pnl(r);
    case "balance":
      return balance(r);
    case "book":
      return book(viewer, r);
    case "portfolio":
      return portfolio(viewer, r);
    case "health":
      return health(viewer, r);
    case "tax":
      return tax(r);
  }
}

/** First day with bank data, for an "All time" preset. */
export async function firstActivity(): Promise<string | null> {
  const [row] = await db.select({ at: bankTransaction.occurredAt }).from(bankTransaction).orderBy(asc(bankTransaction.occurredAt)).limit(1);
  if (!row) return null;
  const p = zonedParts(row.at);
  return dateKey(p.year, p.month, p.day);
}
