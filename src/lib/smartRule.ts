import { GENRES, display } from '$lib/genres';
import type { GenreFilter } from '$lib/genreFilter';

/**
 * A smart playlist's rule. Evaluated against tracks every time the playlist is
 * opened — never stored as membership, so it can't go stale and needs no relink.
 * (A BPM range is deferred: tempo is resolved in code across four providers,
 * not stored where SQL can filter it.)
 */
export interface SmartRule {
  genres?: { include: string[]; exclude: string[] };
  styles?: { include: string[]; exclude: string[] };
  starred?: boolean;
}

function strList(x: unknown): string[] | null {
  if (!Array.isArray(x)) return null;
  if (!x.every((s) => typeof s === 'string' && s.trim() && s.length <= 60)) return null;
  return [...new Set(x as string[])];
}

function sel(x: unknown, allowed?: readonly string[]): { include: string[]; exclude: string[] } | null | undefined {
  if (x === undefined) return undefined;
  if (!x || typeof x !== 'object') return null;
  const o = x as { include?: unknown; exclude?: unknown };
  const include = strList(o.include ?? []);
  const exclude = strList(o.exclude ?? []);
  if (!include || !exclude) return null;
  if (allowed && [...include, ...exclude].some((g) => !allowed.includes(g))) return null;
  return { include, exclude };
}

/** The rule, normalised, or null when anything about it is invalid. */
export function validateRule(raw: unknown): SmartRule | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const genres = sel(r.genres, GENRES);
  const styles = sel(r.styles);
  if (genres === null || styles === null) return null;
  if (r.starred !== undefined && typeof r.starred !== 'boolean') return null;
  return { ...(genres && { genres }), ...(styles && { styles }), ...(r.starred ? { starred: true } : {}) };
}

export function isEmptyRule(r: SmartRule): boolean {
  return (
    !r.starred &&
    !r.genres?.include.length && !r.genres?.exclude.length &&
    !r.styles?.include.length && !r.styles?.exclude.length
  );
}

export function ruleToFilter(r: SmartRule): GenreFilter {
  return { genres: r.genres, styles: r.styles };
}

export function ruleSummary(r: SmartRule): string {
  const parts: string[] = [];
  if (r.genres?.include.length) parts.push(r.genres.include.map(display).join(' or '));
  for (const g of r.genres?.exclude ?? []) parts.push(`not ${display(g)}`);
  if (r.styles?.include.length) parts.push(r.styles.include.map(display).join(', '));
  for (const s of r.styles?.exclude ?? []) parts.push(`not ${display(s)}`);
  if (r.starred) parts.push('starred');
  return parts.join(' · ') || 'no rule yet';
}
