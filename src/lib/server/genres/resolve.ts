import type { Database } from 'bun:sqlite';
import {
  staticVocabulary, extendVocabulary, mapTerms, splitFileGenre, mapBandcampGenre, inferGenres,
  type Vocabulary,
} from './vocabulary';

export type GenreOrigin = 'manual' | 'discogs' | 'bandcamp' | 'file';
interface Answer { genres: string[]; styles: string[]; origin: GenreOrigin }

function parse<T>(s: string | null | undefined, fallback: T): T {
  if (s == null) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

/** Static styles plus any style a Discogs release carries, parented by that release's genres. */
export function loadVocabulary(db: Database): Vocabulary {
  const v = staticVocabulary();
  const rows = db.prepare(
    `SELECT g.value AS genres, s.value AS styles
       FROM source_facets s
       JOIN source_facets g ON g.entity_kind='release' AND g.entity_id=s.entity_id AND g.source='discogs' AND g.key='genres'
      WHERE s.entity_kind='release' AND s.source='discogs' AND s.key='styles'`,
  ).all() as { genres: string; styles: string }[];
  for (const r of rows) {
    const genres = parse<string[]>(r.genres, []);
    for (const s of parse<string[]>(r.styles, [])) if (!v.parents.has(s)) extendVocabulary(v, s, genres);
  }
  return v;
}

/**
 * One answer per release; the first source that yields anything wins as a
 * whole set (manual → Discogs → Bandcamp → file tags). Sources are never
 * merged — a Discogs style list plus a label's Bandcamp tags is noisier than
 * either. Rebuilds every release when `releaseIds` is omitted.
 */
export function resolveGenres(db: Database, releaseIds?: string[]): { tagged: number; untagged: number } {
  const v = loadVocabulary(db);
  const scope = releaseIds ? `WHERE id IN (${releaseIds.map(() => '?').join(',')})` : '';
  const ids = (db.prepare(`SELECT id FROM release ${scope}`).all(...(releaseIds ?? [])) as { id: string }[]).map((r) => r.id);
  if (!ids.length) return { tagged: 0, untagged: 0 };

  const manual = new Map(
    (db.prepare(`SELECT release_id, genres, styles FROM release_tag_manual`).all() as { release_id: string; genres: string; styles: string }[])
      .map((r) => [r.release_id, r]),
  );
  const discogs = new Map<string, { genres: string[]; styles: string[] }>();
  for (const r of db.prepare(
    `SELECT entity_id, key, value FROM source_facets WHERE entity_kind='release' AND source='discogs' AND key IN ('genres','styles')`,
  ).all() as { entity_id: string; key: 'genres' | 'styles'; value: string }[]) {
    const d = discogs.get(r.entity_id) ?? { genres: [], styles: [] };
    d[r.key] = parse<string[]>(r.value, []);
    discogs.set(r.entity_id, d);
  }
  const bandcamp = new Map<string, { genre: string | null; tags: string[] }[]>();
  for (const r of db.prepare(
    `SELECT release_id, primary_genre, tags FROM bandcamp_item WHERE release_id IS NOT NULL`,
  ).all() as { release_id: string; primary_genre: string | null; tags: string | null }[]) {
    bandcamp.set(r.release_id, [...(bandcamp.get(r.release_id) ?? []), { genre: r.primary_genre, tags: parse<string[]>(r.tags, []) }]);
  }
  const fileGenres = new Map<string, string[]>();
  for (const r of db.prepare(
    `SELECT t.release_id, f.value FROM track t
       JOIN source_facets f ON f.entity_kind='track' AND f.entity_id=t.id AND f.source='local' AND f.key='genre'
      WHERE t.release_id IS NOT NULL`,
  ).all() as { release_id: string; value: string }[]) {
    fileGenres.set(r.release_id, [...(fileGenres.get(r.release_id) ?? []), parse<string>(r.value, '')]);
  }

  const answer = (id: string): Answer | null => {
    const m = manual.get(id);
    if (m) return { genres: parse<string[]>(m.genres, []), styles: parse<string[]>(m.styles, []), origin: 'manual' };
    const d = discogs.get(id);
    if (d && (d.genres.length || d.styles.length)) {
      return { genres: inferGenres(d.genres, d.styles, v), styles: d.styles, origin: 'discogs' };
    }
    const bc = bandcamp.get(id);
    if (bc) {
      // The primary genre is not a style term: "experimental" would become the
      // Experimental style. It counts only through mapBandcampGenre.
      const mapped = mapTerms(bc.flatMap((b) => b.tags), v);
      const primary = bc.map((b) => (b.genre ? mapBandcampGenre(b.genre) : null)).filter((g): g is string => !!g);
      const genres = inferGenres([...new Set([...mapped.genres, ...primary])], mapped.styles, v);
      if (genres.length || mapped.styles.length) return { genres, styles: mapped.styles, origin: 'bandcamp' };
    }
    const f = fileGenres.get(id);
    if (f) {
      const mapped = mapTerms(f.flatMap(splitFileGenre), v);
      const genres = inferGenres(mapped.genres, mapped.styles, v);
      if (genres.length || mapped.styles.length) return { genres, styles: mapped.styles, origin: 'file' };
    }
    return null;
  };

  let tagged = 0;
  const del = db.prepare(`DELETE FROM release_genre WHERE release_id = ?`);
  const ins = db.prepare(
    `INSERT OR IGNORE INTO release_genre (release_id, kind, name, position, origin) VALUES (?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    for (const id of ids) {
      del.run(id);
      const a = answer(id);
      if (!a) continue;
      a.genres.forEach((g, i) => ins.run(id, 'genre', g, i, a.origin));
      a.styles.forEach((s, i) => ins.run(id, 'style', s, i, a.origin));
      if (a.genres.length) tagged++;
    }
  })();
  return { tagged, untagged: ids.length - tagged };
}
