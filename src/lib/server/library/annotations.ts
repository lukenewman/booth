import type { Database } from 'bun:sqlite';

/**
 * Booth-native annotations: the user's own judgments about their collection.
 *
 * These deliberately do NOT bump `updated_at` on the entity — that column
 * tracks how fresh the source-derived data is, and starring a track tells you
 * nothing about that. Nor do they touch source_link / source_facets /
 * match_key, which are for external-source ingestion only.
 */

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

export function setTrackStar(
  db: Database,
  trackId: string,
  starred: boolean,
): { starredAt: string | null } {
  // COALESCE on the set path so a double-fire from the UI can't rewrite the
  // original timestamp — "when did I first star this" stays answerable.
  db.prepare(
    starred
      ? `UPDATE track SET starred_at = COALESCE(starred_at, ${NOW}) WHERE id = ?`
      : `UPDATE track SET starred_at = NULL WHERE id = ?`,
  ).run(trackId);

  const row = db.prepare(`SELECT starred_at FROM track WHERE id = ?`).get(trackId) as
    | { starred_at: string | null }
    | undefined;
  return { starredAt: row?.starred_at ?? null };
}

export function setReleaseVetted(
  db: Database,
  releaseId: string,
  vetted: boolean,
): { vettedAt: string | null } {
  db.prepare(
    vetted
      ? `UPDATE release SET vetted_at = COALESCE(vetted_at, ${NOW}) WHERE id = ?`
      : `UPDATE release SET vetted_at = NULL WHERE id = ?`,
  ).run(releaseId);

  const row = db.prepare(`SELECT vetted_at FROM release WHERE id = ?`).get(releaseId) as
    | { vetted_at: string | null }
    | undefined;
  return { vettedAt: row?.vetted_at ?? null };
}

/** Longest note we will store. Blurbs, not essays. */
export const MAX_NOTE_LENGTH = 1000;

/**
 * Set or clear a track's note.
 *
 * Empty and whitespace-only input clears the note rather than storing '' —
 * otherwise "has a note" needs two checks everywhere and an accidental
 * clear-then-save leaves an invisible empty row behind.
 */
export function setTrackNote(
  db: Database,
  trackId: string,
  note: string | null,
): { note: string | null } {
  const trimmed = note?.trim() ?? '';
  const value = trimmed === '' ? null : trimmed.slice(0, MAX_NOTE_LENGTH);
  db.prepare(`UPDATE track SET note = ? WHERE id = ?`).run(value, trackId);
  const row = db.prepare(`SELECT note FROM track WHERE id = ?`).get(trackId) as
    | { note: string | null }
    | undefined;
  return { note: row?.note ?? null };
}

/**
 * Starred-track counts for a page of releases, in one round-trip.
 *
 * This is what replaces a stored release star: a release-level star would be
 * ambiguous between "front-to-back keeper" and "contains starred tracks", and
 * the second is derivable — so we derive it and don't store either.
 *
 * Releases with no starred tracks are absent from the map, not zero-valued.
 */
export function countStarredByRelease(
  db: Database,
  releaseIds: string[],
): Map<string, number> {
  const out = new Map<string, number>();
  if (releaseIds.length === 0) return out;

  const placeholders = releaseIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT release_id, COUNT(*) AS n
         FROM track
        WHERE starred_at IS NOT NULL
          AND release_id IN (${placeholders})
        GROUP BY release_id`,
    )
    .all(...releaseIds) as { release_id: string; n: number }[];

  for (const r of rows) out.set(r.release_id, r.n);
  return out;
}
