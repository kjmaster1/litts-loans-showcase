/**
 * User-typed search text before it reaches the database (bug hunt 2026-10-11): Postgres
 * rejects NUL bytes in text and a State ID longer than an integer overflowed the column —
 * both were 500s. Control characters become spaces; a State ID is at most 9 digits.
 */
export function cleanSearch(raw: string | null | undefined, max = 100): string {
  return (raw ?? "").replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, max);
}

/** A typed number that could be a State ID (or null when it's too long to be one). */
export function asStateId(q: string): number | null {
  return /^\d{1,9}$/.test(q) ? Number(q) : null;
}

/** Escapes LIKE wildcards so a search for "50%" means the characters. */
export const likeEscape = (q: string) => q.replace(/[\\%_]/g, "\\$&");
