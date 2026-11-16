import { formatCount } from "./format";

/**
 * Plain-English validation messages (QA 2026-10-10). Zod's defaults ("Too big:
 * expected string to have <=2000 characters") are for developers; schemas that set
 * their own message keep it. Pure and client-safe.
 */

type Issue = {
  code: string;
  message: string;
  path: readonly PropertyKey[];
  maximum?: number | bigint;
  minimum?: number | bigint;
  inclusive?: boolean;
  origin?: string;
  expected?: string;
  received?: string;
  format?: string;
};

/** Friendly names for the fields our forms send. */
const FIELD: Record<string, string> = {
  note: "Note",
  text: "Note",
  reason: "Reason",
  description: "Description",
  promiseDollars: "Amount",
  promiseBy: "Promise date",
  nextActionAt: "Follow-up date",
  estimatedValueCents: "Estimated value",
  stateId: "State ID",
  characterName: "Character name",
  username: "Username",
  wallet: "Wallet",
};

function fieldName(path: readonly PropertyKey[]): string | null {
  const key = [...path].reverse().find((p) => typeof p === "string") as string | undefined;
  if (!key) return null;
  if (FIELD[key]) return FIELD[key];
  // camelCase → "Camel case", without unit suffixes.
  const words = key.replace(/(Cents|Dollars|StaffId|Id|Bp|Pct)$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : null;
}

/** Zod's own wording starts with one of these; anything else was written by us. */
const DEFAULT = /^(Too big|Too small|Invalid input|Invalid |Expected |Unrecognized key|Required$)/;

export function friendlyIssue(issue: Issue): string {
  if (!DEFAULT.test(issue.message)) return issue.message;
  const field = fieldName(issue.path);
  const subject = field ?? "This";
  const n = (v: number | bigint | undefined) => formatCount(Number(v ?? 0));
  switch (issue.code) {
    case "too_big":
      if (issue.origin === "string") return `${subject} is too long. Keep it to ${n(issue.maximum)} characters or fewer.`;
      if (issue.origin === "array") return `Choose ${n(issue.maximum)} or fewer.`;
      return `${subject} must be ${n(issue.maximum)} or less.`;
    case "too_small":
      if (issue.origin === "string") return Number(issue.minimum) <= 1 ? `${subject} can't be empty.` : `${subject} needs at least ${n(issue.minimum)} characters.`;
      if (issue.origin === "array") return "Choose at least one.";
      return issue.inclusive === false ? `${subject} must be more than ${n(issue.minimum)}.` : `${subject} must be at least ${n(issue.minimum)}.`;
    case "invalid_type":
      if (issue.expected === "number") return `${subject} must be a number.`;
      if (issue.received === "undefined" || issue.message.includes("undefined")) return `${subject} is required.`;
      return `${subject} isn't valid.`;
    case "invalid_format":
      return `${subject} isn't in the right format.`;
    case "invalid_value":
      return `Choose one of the options for ${subject.toLowerCase()}.`;
    default:
      return `${subject} isn't valid.`;
  }
}
