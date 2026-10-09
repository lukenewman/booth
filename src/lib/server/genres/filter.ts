import type { Database } from 'bun:sqlite';
import type { GenreFilter } from '../../genreFilter';

const inList = (n: number) => Array(n).fill('?').join(',');

/**
 * WHERE fragments over a release id column (`release.id` or
 * `track.release_id`). Includes are any-of. Excludes only ever match tagged
 * releases: "not electronic" means "known to be something else", and untagged
 * records have their own view.
 */
export function genreWhere(col: string, f: GenreFilter | undefined): { where: string[]; params: string[] } {
  const where: string[] = [];
  const params: string[] = [];
  if (!f) return { where, params };
  const tagged = `${col} IN (SELECT release_id FROM release_genre WHERE kind = 'genre')`;
  for (const kind of ['genre', 'style'] as const) {
    const sel = kind === 'genre' ? f.genres : f.styles;
    if (sel?.include.length) {
      where.push(`${col} IN (SELECT release_id FROM release_genre WHERE kind = '${kind}' AND name IN (${inList(sel.include.length)}))`);
      params.push(...sel.include);
    }
    if (sel?.exclude.length) {
      where.push(tagged, `${col} NOT IN (SELECT release_id FROM release_genre WHERE kind = '${kind}' AND name IN (${inList(sel.exclude.length)}))`);
      params.push(...sel.exclude);
    }
  }
  if (f.untagged) {
    where.push(`${col} IS NOT NULL AND ${col} NOT IN (SELECT release_id FROM release_genre WHERE kind = 'genre')`);
  }
  return { where, params };
}

/** Resolved styles for a page of releases, in source order. One round-trip. */
export function stylesByRelease(db: Database, releaseIds: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const ids = [...new Set(releaseIds)];
  if (!ids.length) return out;
  const rows = db.prepare(
    `SELECT release_id, name FROM release_genre
      WHERE kind = 'style' AND release_id IN (${inList(ids.length)})
      ORDER BY release_id, position`,
  ).all(...ids) as { release_id: string; name: string }[];
  for (const r of rows) {
    const list = out.get(r.release_id);
    if (list) list.push(r.name);
    else out.set(r.release_id, [r.name]);
  }
  return out;
}
