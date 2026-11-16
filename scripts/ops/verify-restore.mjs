// Checks a database restored from a backup (.github/workflows/restore-drill.yml; owner,
// 2026-10-11: test a restore, then monthly). Compares it with the live database (read-only).
// Usage: RESTORED_URL=… LIVE_URL=… node scripts/ops/verify-restore.mjs
import { appendFileSync } from "node:fs";
import pg from "pg";

const connect = async (url, label) => {
  if (!url) {
    console.error(`${label} is not set`);
    process.exit(2);
  }
  const u = new URL(url);
  if (u.searchParams.get("sslmode") === "require") u.searchParams.set("sslmode", "verify-full");
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  return c;
};
const restored = await connect(process.env.RESTORED_URL, "RESTORED_URL");
const live = process.env.LIVE_URL ? await connect(process.env.LIVE_URL, "LIVE_URL") : null;

// Tables the business can't lose. Ledger and audit tables are append-only, so the live
// copy must have at least as many rows as the backup.
const TABLES = ["staff", "loan", "mortgage", "bank_transaction", "journal_entry", "journal_line", "audit_event", "loan_payment_link", "company_setting"];
const problems = [];
const rows = [];
for (const t of TABLES) {
  // A table the live app has but the backup lacks means the backup predates it (stale).
  const exists = (await restored.query(`select to_regclass($1) as t`, [`public.${t}`])).rows[0].t;
  if (!exists) {
    rows.push(`| ${t} | missing | — |`);
    problems.push(`${t} is missing from the backup — the backup is older than that part of the app`);
    continue;
  }
  const r = Number((await restored.query(`select count(*) as n from ${t}`)).rows[0].n);
  const l = live ? Number((await live.query(`select count(*) as n from ${t}`)).rows[0].n) : null;
  rows.push(`| ${t} | ${r} | ${l ?? "—"} |`);
  if (r === 0 && t !== "company_setting") problems.push(`${t} is empty in the restore`);
  if (l !== null && r > l) problems.push(`${t}: the restore has more rows (${r}) than live (${l})`);
}

// The books must balance in the restore exactly as they do live.
const tb = (await restored.query(`select coalesce(sum(debit_cents), 0) as d, coalesce(sum(credit_cents), 0) as c from journal_line`)).rows[0];
if (tb.d !== tb.c) problems.push(`Trial balance is off: debits ${tb.d} vs credits ${tb.c}`);
const unbalanced = Number(
  (await restored.query(`select count(*) as n from (select entry_id from journal_line group by entry_id having sum(debit_cents) <> sum(credit_cents)) x`)).rows[0].n,
);
if (unbalanced) problems.push(`${unbalanced} journal entries don't balance`);
const newest = (await restored.query(`select max(occurred_at) as at from audit_event`)).rows[0].at;
const ageHours = newest ? (Date.now() - new Date(newest).getTime()) / 3_600_000 : Infinity;
// Nightly backups: the newest should never be much more than a day old.
if (ageHours > 36) problems.push(`The newest backup is ${ageHours.toFixed(0)} hours old — the nightly backup may have stopped`);

await restored.end();
await live?.end();

const summary = [
  `## Restore drill — ${problems.length ? "FAILED" : "passed"}`,
  "",
  ...problems.map((p) => `**${p}**`),
  "",
  "| Table | Restored | Live now |",
  "|---|---:|---:|",
  ...rows,
  "",
  `Trial balance: debits ${tb.d} = credits ${tb.c} (cents). Unbalanced entries: ${unbalanced}.`,
  `Newest audit entry in the backup: ${newest ? new Date(newest).toISOString() : "none"} (${ageHours.toFixed(1)} hours old).`,
].join("\n");
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
process.exit(problems.length ? 1 : 0);
