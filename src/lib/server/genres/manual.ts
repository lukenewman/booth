import type { Database } from 'bun:sqlite';
import { GENRES } from '../../genres';
import { resolveGenres, type GenreOrigin } from './resolve';
import { assignStyleColors } from './colors';

export class TagValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TagValidationError';
  }
}

const MAX_STYLE_LENGTH = 60;

/**
 * Set (or, with null, clear) a release's hand-made genres and styles, then
 * re-resolve it. A manual answer outranks every source and no sync touches it;
 * clearing falls back to whatever the sources say. Styles outside the
 * vocabulary are allowed — they just have no parent genre.
 */
export function setManualTags(
  db: Database,
  releaseId: string,
  tags: { genres: string[]; styles: string[] } | null,
): { genres: string[]; styles: string[]; genreOrigin: GenreOrigin | null } {
  if (tags) {
    const genres = [...new Set(tags.genres)];
    if (genres.some((g) => !(GENRES as readonly string[]).includes(g))) throw new TagValidationError('unknown genre');
    const styles = [...new Set(tags.styles.map((s) => (typeof s === 'string' ? s.trim() : '')))];
    if (styles.some((s) => !s || s.length > MAX_STYLE_LENGTH)) throw new TagValidationError('bad style');
    db.prepare(
      `INSERT INTO release_tag_manual (release_id, genres, styles, set_at)
       VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(release_id) DO UPDATE SET genres = excluded.genres, styles = excluded.styles, set_at = excluded.set_at`,
    ).run(releaseId, JSON.stringify(genres), JSON.stringify(styles));
  } else {
    db.prepare(`DELETE FROM release_tag_manual WHERE release_id = ?`).run(releaseId);
  }
  resolveGenres(db, [releaseId]);
  assignStyleColors(db);
  const rows = db
    .prepare(`SELECT kind, name, origin FROM release_genre WHERE release_id = ? ORDER BY kind, position`)
    .all(releaseId) as { kind: string; name: string; origin: GenreOrigin }[];
  return {
    genres: rows.filter((r) => r.kind === 'genre').map((r) => r.name),
    styles: rows.filter((r) => r.kind === 'style').map((r) => r.name),
    genreOrigin: rows[0]?.origin ?? null,
  };
}
