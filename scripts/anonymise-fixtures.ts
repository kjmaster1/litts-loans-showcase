/**
 * Builds anonymised test fixtures from the owner's real exports.
 *
 *   reference/samples/*  (real data, gitignored)  →  tests/fixtures/*  (committed)
 *
 * What changes: character names (incl. abbreviations, first-name-only and
 * upper-case surname mentions inside free-text comments), State IDs, personal
 * wallet IDs, in-game loan/agreement IDs, and the real-estate agency name.
 * What is kept: amounts, timestamps, tax, rates, transaction types, property
 * addresses (GTA map locations) and the company/State/escrow wallets the
 * business logic depends on — so every calculation still reconciles.
 *
 * The real→fake mapping is persisted to reference/anonymisation-map.json
 * (gitignored) so re-running is stable. The script finishes with a leak check
 * and exits non-zero if any original name fragment survives.
 *
 *   pnpm fixtures:anonymise
 */
import { randomBytes, randomInt } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import * as XLSX from "xlsx";

const SRC = "reference/samples";
const OUT = "tests/fixtures";
const MAP_FILE = "reference/anonymisation-map.json";
const NEWLINE = /\r?\n/;

/** Wallets the business logic is keyed on — not personal data, kept as-is. */
const SYSTEM_WALLETS = new Set(["69811362", "69794349", "69833729", "69740396"]);
const SYSTEM_NAMES = new Set(["San Andreas State"]);
const SYSTEM_STATE_IDS = new Set(["101"]);

/**
 * Real-name knowledge (names that appear only inside comments, misspellings,
 * first-name-only mentions, …) is itself personal data, so it lives in the
 * gitignored reference/anonymise-config.json rather than in this script.
 */
type AnonymiseConfig = {
  /** Names that occur only inside free-text comments (found by manual review). */
  commentOnlyNames: string[];
  /** Misspellings / fragments seen in comments → the person they refer to. */
  aliases: Record<string, string>;
  /** First names used alone in comments → full name. */
  firstNameOnly: Record<string, string>;
  /** Upper-case surname tags (e.g. "[SURNAME - DEFAULTED]") → full name. */
  upperSurnames: Record<string, string>;
  /** Businesses named after a person → that person. */
  businessNames: Record<string, string>;
  /** Name fragments that are also ordinary/place words in kept data. */
  leakCheckStopWords: string[];
};
const config = JSON.parse(readFileSync("reference/anonymise-config.json", "utf8")) as AnonymiseConfig;
const COMMENT_ONLY_NAMES = config.commentOnlyNames;
const ALIASES = config.aliases;
const FIRST_NAME_ONLY = config.firstNameOnly;
const UPPER_SURNAMES = config.upperSurnames;
const BUSINESS_NAMES = config.businessNames;

const FIRST = ["Avery", "Blake", "Casey", "Dakota", "Emery", "Finley", "Harper", "Jordan", "Kai", "Logan", "Marley", "Nico", "Oakley", "Parker", "Quinn", "Reese", "Rowan", "Sage", "Skyler", "Tatum", "Remy", "Wren", "Ellis", "Jules", "Arden", "Bellamy", "Cyan", "Darcy", "Ember", "Frankie", "Greer", "Hollis", "Indie", "Jesse", "Kendall", "Lane", "Morgan", "Noel", "Onyx", "Peyton", "Ridley", "Shea", "Tobin", "Vale", "Winter", "Zion", "Arlo", "Briar", "Cove", "Dell"];
const LAST = ["Ashdown", "Blackwood", "Calloway", "Draycott", "Everhart", "Fairbanks", "Galloway", "Hartwell", "Ironside", "Jessop", "Kingsley", "Larkspur", "Merriweather", "Northcott", "Oakhurst", "Pemberton", "Quarles", "Ravenscroft", "Stirling", "Thornbury", "Underhill", "Vance", "Whitlock", "Yardley", "Ashcombe", "Brightwater", "Coldwell", "Dunmore", "Elsworth", "Foxley", "Greystone", "Holloway", "Kestrel", "Lockhart", "Marlowe", "Nettleton", "Oswin", "Prescott", "Redgrave", "Sutcliffe", "Tremaine", "Wexford", "Axworthy", "Bramley", "Crestwood", "Delacroix"];

const xlsxName = readdirSync(SRC).find((f) => f.endsWith(".xlsx"))!;
const mortgageSource = readFileSync(`${SRC}/Mortgage Information Copy-Paste Example.txt`, "utf8").split(NEWLINE);

/**
 * Every real name in the sources, gathered up front so the fake-name pools can
 * exclude any token that also appears in a real name (otherwise the leak check
 * can't tell a fake "Logan" from a real one).
 */
function realNames(): string[] {
  const names = new Set<string>([
    ...COMMENT_ONLY_NAMES,
    ...Object.values(FIRST_NAME_ONLY),
    ...Object.values(UPPER_SURNAMES),
    ...Object.values(BUSINESS_NAMES),
  ]);
  const book = XLSX.read(readFileSync(`${SRC}/${xlsxName}`));
  const rows = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[book.SheetNames[0]], { header: 1, blankrows: true });
  // Row 3 holds the owner's name; transactions start at row 7 (rows 1–6 are headers).
  for (const row of [rows[2], ...rows.slice(6)]) {
    if (typeof row?.[6] === "string" && row[6]) names.add(row[6]);
  }
  for (const line of mortgageSource) {
    const m = /^#\d+ (.+)$/.exec(line);
    if (m) names.add(m[1]);
  }
  return [...names];
}
const REAL_TOKENS = new Set(realNames().flatMap((n) => n.toLowerCase().split(/[\s-]+/)));
const FIRST_POOL = FIRST.filter((n) => !REAL_TOKENS.has(n.toLowerCase()));
const LAST_POOL = LAST.filter((n) => !REAL_TOKENS.has(n.toLowerCase()));

type MapFile = {
  names: Record<string, string>;
  stateIds: Record<string, string>;
  wallets: Record<string, string>;
  hex: Record<string, string>;
};

const map: MapFile = existsSync(MAP_FILE)
  ? (JSON.parse(readFileSync(MAP_FILE, "utf8")) as MapFile)
  : { names: {}, stateIds: {}, wallets: {}, hex: {} };

function unique<T>(taken: Set<T>, make: () => T): T {
  for (;;) {
    const v = make();
    if (!taken.has(v)) return v;
  }
}

function fakeName(real: string): string {
  if (SYSTEM_NAMES.has(real)) return real;
  if (!map.names[real]) {
    const taken = new Set(Object.values(map.names));
    map.names[real] = unique(taken, () => `${FIRST_POOL[randomInt(FIRST_POOL.length)]} ${LAST_POOL[randomInt(LAST_POOL.length)]}`);
  }
  return map.names[real];
}

function fakeStateId(real: string): string {
  if (SYSTEM_STATE_IDS.has(real)) return real;
  if (!map.stateIds[real]) {
    const taken = new Set([...Object.values(map.stateIds), ...Object.keys(map.stateIds)]);
    map.stateIds[real] = unique(taken, () => String(randomInt(1000, 28000)));
  }
  return map.stateIds[real];
}

function fakeWallet(real: string): string {
  if (SYSTEM_WALLETS.has(real)) return real;
  if (!map.wallets[real]) {
    const taken = new Set([...Object.values(map.wallets), ...Object.keys(map.wallets), ...SYSTEM_WALLETS]);
    map.wallets[real] = unique(taken, () => `69${String(randomInt(0, 1_000_000)).padStart(6, "0")}`);
  }
  return map.wallets[real];
}

/** Same-shape random replacement (keeps UUID dashes). */
function fakeHex(real: string): string {
  if (!map.hex[real]) {
    const fresh = randomBytes(real.length).toString("hex");
    let i = 0;
    map.hex[real] = real.replace(/[0-9a-f]/gi, () => fresh[i++]);
  }
  return map.hex[real];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Replacement rules for free text, longest patterns first. */
function textRules(): [RegExp, string][] {
  const rules: [string, string][] = [];
  for (const [alias, canonical] of Object.entries(ALIASES)) rules.push([alias, fakeName(canonical)]);
  for (const real of Object.keys(map.names)) {
    const fake = map.names[real];
    rules.push([real, fake]);
    const [first, ...rest] = real.split(" ");
    const [fFirst, ...fRest] = fake.split(" ");
    if (rest.length) rules.push([`${first} ${rest[rest.length - 1][0]}.`, `${fFirst} ${fRest[fRest.length - 1][0]}.`]);
  }
  for (const [upper, canonical] of Object.entries(UPPER_SURNAMES)) {
    rules.push([upper, fakeName(canonical).split(" ").slice(1).join(" ").toUpperCase()]);
  }
  for (const [biz, person] of Object.entries(BUSINESS_NAMES)) {
    rules.push([biz, `${fakeName(person).split(" ").slice(-1)[0]} Properties`]);
  }
  for (const [first, canonical] of Object.entries(FIRST_NAME_ONLY)) rules.push([first, fakeName(canonical).split(" ")[0]]);
  rules.sort((a, b) => b[0].length - a[0].length);
  return rules.map(([from, to]) => [new RegExp(`(?<![\\w-])${escape(from)}(?![\\w-])`, "g"), to]);
}

function anonymiseText(text: string, rules: [RegExp, string][]): string {
  let out = text;
  for (const [re, to] of rules) out = out.replace(re, to);
  // In-game identifiers: 24-hex agreement IDs and UUIDs.
  out = out.replace(/\b[0-9a-f]{24}\b/g, fakeHex);
  out = out.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, fakeHex);
  // "[SID 12345]" tags.
  out = out.replace(/\[SID (\d+)\]/g, (_, id: string) => `[SID ${fakeStateId(id)}]`);
  return out;
}

// ---------------------------------------------------------------- bank export
const wb = XLSX.read(readFileSync(`${SRC}/${xlsxName}`));
const ws = wb.Sheets[wb.SheetNames[0]];
const range = XLSX.utils.decode_range(ws["!ref"]!);
const cell = (r: number, c: number) => ws[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined;

// Register every name first so the text rules know them all.
for (const n of realNames()) fakeName(n);
const ownerName = cell(2, 6)?.v;
const rules = textRules();

const setCell = (r: number, c: number, v: string | number) => {
  const existing = cell(r, c);
  if (!existing) return;
  existing.v = v;
  existing.t = typeof v === "number" ? "n" : "s";
  delete existing.w;
};

// Header: owner name and State ID.
if (typeof ownerName === "string") setCell(2, 6, fakeName(ownerName));
const ownerId = cell(2, 4)?.v;
if (ownerId !== undefined) setCell(2, 4, fakeStateId(String(ownerId)));

for (let r = 6; r <= range.e.r; r++) {
  for (const c of [4, 5]) {
    const v = cell(r, c)?.v;
    if (v !== undefined && v !== null && v !== "") setCell(r, c, fakeWallet(String(v)));
  }
  const name = cell(r, 6)?.v;
  if (typeof name === "string" && name) setCell(r, 6, fakeName(name));
  const sid = cell(r, 7)?.v;
  if (sid !== undefined && sid !== null && sid !== "") {
    const fake = fakeStateId(String(sid));
    setCell(r, 7, typeof sid === "number" ? Number(fake) : fake);
  }
  const comment = cell(r, 8)?.v;
  if (typeof comment === "string") setCell(r, 8, anonymiseText(comment, rules));
}

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/bank-export.xlsx`, XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));

// ---------------------------------------------------------------- copy-pastes
const PASTE_FILES: Record<string, string> = {
  "Active Tab Copy-Paste Example.txt": "paste-active.txt",
  "Overdue Tab Copy-Paste Example.txt": "paste-overdue.txt",
  "Default Tab Copy-Paste Example.txt": "paste-default.txt",
  "Complete Tab Copy-Paste Example.txt": "paste-complete.txt",
};

for (const [src, dest] of Object.entries(PASTE_FILES)) {
  const lines = readFileSync(`${SRC}/${src}`, "utf8").split(NEWLINE);
  // Each card starts with "$x.xx", then the wallet line, then the borrower's State ID.
  for (let i = 0; i < lines.length; i++) {
    if (/^\$[\d,]+\.\d{2}$/.test(lines[i]) && /^\d+$/.test(lines[i + 2] ?? "")) {
      lines[i + 1] = fakeWallet(lines[i + 1]);
      lines[i + 2] = fakeStateId(lines[i + 2]);
      i += 2;
    }
  }
  writeFileSync(`${OUT}/${dest}`, lines.map((l) => anonymiseText(l, rules)).join("\n"));
}

const mortgage = mortgageSource
  .map((l) => {
    const m = /^#(\d+) (.+)$/.exec(l);
    return m ? `#${fakeStateId(m[1])} ${fakeName(m[2])}` : anonymiseText(l, rules);
  })
  .join("\n");
writeFileSync(`${OUT}/paste-mortgage.txt`, mortgage);

writeFileSync(MAP_FILE, JSON.stringify(map, null, 2));

// ---------------------------------------------------------------- leak check
// Fragments that are also place/business words in the kept data (e.g. "Litt's
// Loans", "… Road"); full names are still checked below.
const STOP = new Set(config.leakCheckStopWords);
const fragments = new Set<string>();
for (const real of Object.keys(map.names)) {
  if (SYSTEM_NAMES.has(real)) continue;
  for (const part of real.split(/[\s-]+/)) if (part.length >= 4 && !STOP.has(part)) fragments.add(part);
}
const outputs = readdirSync(OUT).map((f) => {
  if (f.endsWith(".xlsx")) {
    const b = XLSX.read(readFileSync(`${OUT}/${f}`));
    return [f, XLSX.utils.sheet_to_csv(b.Sheets[b.SheetNames[0]])] as const;
  }
  return [f, readFileSync(`${OUT}/${f}`, "utf8")] as const;
});
const leaks: string[] = [];
for (const [file, text] of outputs) {
  for (const frag of fragments) {
    if (new RegExp(`(?<![\\w])${escape(frag)}(?![\\w])`, "i").test(text)) leaks.push(`${file}: "${frag}"`);
  }
  // Fully-qualified names are checked even for stop-listed parts.
  for (const real of Object.keys(map.names)) {
    if (!SYSTEM_NAMES.has(real) && text.includes(real)) leaks.push(`${file}: full name "${real}"`);
  }
  for (const id of Object.keys(map.stateIds)) {
    if (new RegExp(`\\[SID ${id}\\]`).test(text)) leaks.push(`${file}: SID ${id}`);
  }
}
if (leaks.length) {
  console.error(`Leak check FAILED (${leaks.length}):\n  ${[...new Set(leaks)].join("\n  ")}`);
  process.exit(1);
}
console.log(
  `Wrote ${outputs.length} fixtures to ${OUT}. Mapped ${Object.keys(map.names).length} names, ` +
    `${Object.keys(map.stateIds).length} State IDs, ${Object.keys(map.wallets).length} wallets. Leak check passed.`,
);
