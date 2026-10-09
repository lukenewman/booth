// Matching a typed runout etching against Discogs's "Matrix / Runout"
// identifiers. Pure, so the add flow's version filter and any script can share it.

export interface Identifier {
  type: string;
  value: string;
  description: string | null;
}

/** One runout line: Discogs's description ("Side A", "Runout side B, etched") + value. */
export interface RunoutLine {
  label: string | null;
  value: string;
}

export function runoutLines(identifiers: Identifier[]): RunoutLine[] {
  return identifiers
    .filter((i) => i.type === 'Matrix / Runout')
    .map((i) => ({ label: i.description, value: i.value }));
}

/**
 * Lowercase and keep only letters and digits. Etchings are transcribed
 * inconsistently — "YEX 123-1", "YEX-123 1", "YEX123‐1" — and what you read
 * off the vinyl rarely matches anyone's spacing or dashes, so compare on the
 * characters alone. NFKD splits accented letters so "é" still matches "e".
 */
export function normalizeRunout(s: string): string {
  return s.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The lines that match `query`, or null when the release doesn't match.
 *
 * Every whitespace-separated token must appear somewhere in the release's
 * runouts, so "yex 123 porky" narrows the way you'd expect, and fragments read
 * off different sides can be combined. A token never spans two lines (it is
 * alphanumeric, and lines are compared one at a time). The returned lines are
 * for display, in Discogs's order: the ones holding the whole query when any
 * do (typing "yex 123 1" means one side's etching, and the other side's "1"
 * is noise), else every line holding at least one token.
 */
export function matchRunout(query: string, lines: RunoutLine[]): RunoutLine[] | null {
  const tokens = query.split(/\s+/).map(normalizeRunout).filter(Boolean);
  if (tokens.length === 0) return lines;
  const normalized = lines.map((l) => normalizeRunout(l.value));
  if (!tokens.every((t) => normalized.some((n) => n.includes(t)))) return null;
  const whole = tokens.join('');
  const exact = lines.filter((_, i) => normalized[i].includes(whole));
  if (exact.length) return exact;
  return lines.filter((_, i) => tokens.some((t) => normalized[i].includes(t)));
}
