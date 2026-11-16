// Audit anchors (owner review 2026-10-11): each night the backup job records the newest audit
// entry's id and hash on the repository's `audit-anchors` branch — outside the database and
// outside Vercel. This checks the recent anchors still match the live table. Every row's hash
// covers the previous row's, so an unchanged anchored hash means nothing before it was rewritten
// (even by someone holding the audit key). Content edits without re-signing are caught by the
// in-app chain check (Audit page). Read-only.
// Usage: DATABASE_URL=… node scripts/ops/check-anchors.mjs anchors.csv
import { appendFileSync, readFileSync } from "node:fs";
import pg from "pg";

const file = process.argv[2];
const lines = readFileSync(file, "utf8").trim().split(/\r?\n/).slice(1).filter(Boolean);
const recent = lines.slice(-14); // two weeks of nightly anchors
const url = new URL(process.env.DATABASE_URL ?? "");
if (url.searchParams.get("sslmode") === "require") url.searchParams.set("sslmode", "verify-full");
const db = new pg.Client({ connectionString: url.toString() });
await db.connect();

const problems = [];
for (const line of recent) {
  const [recordedAt, id, hash] = line.split(",");
  const { rows } = await db.query("select hash from audit_event where id = $1", [id]);
  if (!rows.length) problems.push(`Audit entry ${id} (anchored ${recordedAt}) is missing`);
  else if (rows[0].hash !== hash) problems.push(`Audit entry ${id} (anchored ${recordedAt}) has a different hash — the log was rewritten`);
}
await db.end();

const summary = [
  `## Audit anchors — ${problems.length ? "MISMATCH" : recent.length === 1 ? "the recent anchor matches" : `all ${recent.length} recent anchors match`}`,
  ...problems.map((p) => `**${p}**`),
].join("\n");
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
process.exit(problems.length ? 1 : 0);
