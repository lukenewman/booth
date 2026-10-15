import type { Database } from 'bun:sqlite';
import { normalizeArtistAlbum, normalizeArtistAlbumYear } from './normalize';
import { upsertReleaseMatchKeys } from './collate';

/**
 * A release's title, set by hand.
 *
 * Local titles sometimes carry what Discogs' don't ("ITLP19 - Resort" against
 * "Resort"), and then the two copies of one record never pair. Setting the
 * title by hand fixes the name and, through the match keys, the pairing: sync
 * reads `title_override` in place of the source's title (see `upsertRelease`
 * in collate), and if the new title already belongs to the other copy, the two
 * are merged here and now rather than waiting for a sync that could not do it
 * — a sync cannot move a release link past an existing one.
 *
 * Clearing the override hands the title back to the sources on the next sync.
 * A merge is not undone by that: both links now sit on one release, and each
 * finds it again through its own external id.
 */

export class TitleMergeBlocked extends Error {}

export interface RenameResult {
  /** The release that carries the title now — the other copy's id after a merge. */
  releaseId: string;
  /** The release merged away, if any. */
  mergedId: string | null;
  /** Tracks whose star or note moved from the Discogs copy onto the local file. */
  carried: { trackId: string; star: boolean; note: boolean }[];
}

interface Rel { id: string; artist: string; year: number | null; local: number; discogs: number }

function rel(db: Database, id: string): Rel | undefined {
  return db
    .prepare(
      `SELECT r.id, a.name AS artist, r.year,
              EXISTS (SELECT 1 FROM source_link WHERE entity_kind='release' AND entity_id=r.id AND source='local') AS local,
              EXISTS (SELECT 1 FROM source_link WHERE entity_kind='release' AND entity_id=r.id AND source='discogs') AS discogs
         FROM release r JOIN artist a ON a.id = r.artist_id WHERE r.id = ?`,
    )
    .get(id) as Rel | undefined;
}

/** The other release the new title would match, as a sync would resolve it. */
function collision(db: Database, self: Rel, title: string): string | null {
  const keys: [string, string | null][] = [
    ['artist_album_year', normalizeArtistAlbumYear({ artist: self.artist, album: title, year: self.year })],
    ['artist_album', normalizeArtistAlbum({ artist: self.artist, album: title })],
  ];
  for (const [type, value] of keys) {
    if (!value) continue;
    const hit = db
      .prepare(`SELECT entity_id FROM match_key WHERE entity_kind='release' AND key_type=? AND key_value=? AND entity_id != ?`)
      .get(type, value, self.id) as { entity_id: string } | undefined;
    if (hit) return hit.entity_id;
  }
  return null;
}

export function setReleaseTitle(db: Database, releaseId: string, title: string | null): RenameResult {
  const clean = title?.trim() || null;
  return db.transaction((): RenameResult => {
    const self = rel(db, releaseId);
    if (!self) throw new Error(`release not found: ${releaseId}`);
    if (!clean) {
      db.prepare(`UPDATE release SET title_override = NULL WHERE id = ?`).run(releaseId);
      return { releaseId, mergedId: null, carried: [] };
    }

    const otherId = collision(db, self, clean);
    let keepId = releaseId;
    let mergedId: string | null = null;
    let carried: RenameResult['carried'] = [];
    if (otherId) {
      const other = rel(db, otherId)!;
      // Only the shape this exists for: one file-backed copy, one Discogs copy.
      // Two local albums or two pressings in the collection are different
      // records that happen to share a name, and stay apart.
      const pair = [self, other];
      const keep = pair.find((r) => r.local && !r.discogs);
      const drop = pair.find((r) => r.discogs && !r.local);
      if (!keep || !drop) {
        throw new TitleMergeBlocked(
          `Another “${clean}” by ${self.artist} is already in the library, and they aren’t a local/Discogs pair to merge`,
        );
      }
      carried = mergeInto(db, keep.id, drop.id);
      keepId = keep.id;
      mergedId = drop.id;
    }

    const keep = rel(db, keepId)!;
    db.prepare(`UPDATE release SET title_override = ?, title = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
      .run(clean, clean, keepId);
    upsertReleaseMatchKeys(db, keepId, { artist: keep.artist, album: clean, year: keep.year });
    return { releaseId: keepId, mergedId, carried };
  })();
}

/**
 * Fold the Discogs-only `drop` into the file-backed `keep`. Each Discogs track
 * row pairs with the local track at the same position — the same rule Discogs
 * hydration uses — and hands over its link, facets, star, note and playlist
 * entries. A row with no counterpart moves across as it is.
 */
function mergeInto(db: Database, keepId: string, dropId: string): RenameResult['carried'] {
  const carried: RenameResult['carried'] = [];
  const tracks = db
    .prepare(
      `SELECT t.id, t.title, t.position, t.starred_at, t.note,
              EXISTS (SELECT 1 FROM source_link sl WHERE sl.entity_kind='track' AND sl.entity_id=t.id AND sl.source<>'discogs') AS other_source
         FROM track t WHERE t.release_id = ?`,
    )
    .all(dropId) as { id: string; title: string; position: string | null; starred_at: string | null; note: string | null; other_source: number }[];

  const counterpart = db.prepare(
    `SELECT t.id, t.starred_at, t.note FROM track t
      WHERE t.release_id = ? AND CAST(t.position AS INTEGER) = ?
        AND EXISTS (SELECT 1 FROM source_link sl WHERE sl.entity_kind='track' AND sl.entity_id=t.id AND sl.source='local')`,
  );

  for (const t of tracks) {
    const posKey = (id: string) => `${id}:${t.position == null ? '' : Number(t.position)}`;
    const matches = t.other_source || t.position == null
      ? []
      : (counterpart.all(keepId, Number(t.position)) as { id: string; starred_at: string | null; note: string | null }[]);

    if (matches.length !== 1) {
      // A file-backed row a sync parented under the Discogs copy, or a Discogs
      // track the files don't have: either way it belongs to the record.
      db.prepare(`UPDATE track SET release_id = ? WHERE id = ?`).run(keepId, t.id);
      db.prepare(
        `UPDATE OR IGNORE match_key SET key_value = ?
          WHERE entity_kind='track' AND entity_id=? AND key_type='release_position'`,
      ).run(posKey(keepId), t.id);
      continue;
    }

    const local = matches[0];
    if (t.note && local.note && t.note !== local.note) {
      throw new TitleMergeBlocked(`“${t.title}” has a different note on each copy — keep one, then rename again`);
    }
    const clash = db
      .prepare(
        `SELECT p.name FROM playlist_track a JOIN playlist_track b ON b.playlist_id = a.playlist_id
           JOIN playlist p ON p.id = a.playlist_id
          WHERE a.track_id = ? AND b.track_id = ?`,
      )
      .get(t.id, local.id) as { name: string } | undefined;
    if (clash) {
      throw new TitleMergeBlocked(`Both copies of “${t.title}” are in “${clash.name}” — remove one, then rename again`);
    }

    const star = !!t.starred_at && !local.starred_at;
    const note = !!t.note && !local.note;
    if (star || note) {
      db.prepare(`UPDATE track SET starred_at = COALESCE(starred_at, ?), note = COALESCE(note, ?) WHERE id = ?`)
        .run(t.starred_at, t.note, local.id);
      carried.push({ trackId: local.id, star, note });
    }
    db.prepare(`UPDATE playlist_track SET track_id = ? WHERE track_id = ?`).run(local.id, t.id);
    db.prepare(`UPDATE source_link SET entity_id = ? WHERE entity_kind='track' AND entity_id = ? AND source='discogs'`).run(local.id, t.id);
    db.prepare(
      `INSERT INTO source_facets (entity_kind, entity_id, source, key, value)
       SELECT 'track', ?, source, key, value FROM source_facets WHERE entity_kind='track' AND entity_id = ?
       ON CONFLICT(entity_kind, entity_id, source, key) DO NOTHING`,
    ).run(local.id, t.id);
    db.prepare(`DELETE FROM source_facets WHERE entity_kind='track' AND entity_id = ?`).run(t.id);
    db.prepare(`DELETE FROM match_key WHERE entity_kind='track' AND entity_id = ?`).run(t.id);
    db.prepare(
      `INSERT OR IGNORE INTO match_key (entity_kind, entity_id, key_type, key_value) VALUES ('track', ?, 'release_position', ?)`,
    ).run(local.id, posKey(keepId));
    db.prepare(`DELETE FROM track WHERE id = ?`).run(t.id);
  }

  // The release itself: its Discogs link and facets, anything booth-native the
  // kept copy lacks, and the gigs it was crated in.
  db.prepare(`UPDATE source_link SET entity_id = ? WHERE entity_kind='release' AND entity_id = ?`).run(keepId, dropId);
  db.prepare(
    `INSERT INTO source_facets (entity_kind, entity_id, source, key, value)
     SELECT 'release', ?, source, key, value FROM source_facets WHERE entity_kind='release' AND entity_id = ?
     ON CONFLICT(entity_kind, entity_id, source, key) DO NOTHING`,
  ).run(keepId, dropId);
  db.prepare(`DELETE FROM source_facets WHERE entity_kind='release' AND entity_id = ?`).run(dropId);
  db.prepare(
    `UPDATE release SET
        country   = COALESCE(country,   (SELECT country   FROM release WHERE id = ?1)),
        label     = COALESCE(label,     (SELECT label     FROM release WHERE id = ?1)),
        catno     = COALESCE(catno,     (SELECT catno     FROM release WHERE id = ?1)),
        vetted_at = COALESCE(vetted_at, (SELECT vetted_at FROM release WHERE id = ?1)),
        cover_override = COALESCE(cover_override, (SELECT cover_override FROM release WHERE id = ?1)),
        thumb_url = CASE WHEN cover_override IS NOT NULL THEN thumb_url
                         ELSE COALESCE((SELECT cover_override FROM release WHERE id = ?1), thumb_url, (SELECT thumb_url FROM release WHERE id = ?1)) END,
        cover_url = CASE WHEN cover_override IS NOT NULL THEN cover_url
                         ELSE COALESCE((SELECT cover_override FROM release WHERE id = ?1), cover_url, (SELECT cover_url FROM release WHERE id = ?1)) END
      WHERE id = ?2`,
  ).run(dropId, keepId);
  db.prepare(`UPDATE OR IGNORE release_tag_manual SET release_id = ? WHERE release_id = ?`).run(keepId, dropId);
  db.prepare(`UPDATE bandcamp_item SET release_id = ? WHERE release_id = ?`).run(keepId, dropId);
  db.prepare(`UPDATE OR IGNORE playlist_release SET release_id = ? WHERE release_id = ?`).run(keepId, dropId);
  // Left behind only where a gig already crated the kept copy.
  db.prepare(`DELETE FROM playlist_release WHERE release_id = ?`).run(dropId);
  db.prepare(`DELETE FROM match_key WHERE entity_kind='release' AND entity_id = ?`).run(dropId);
  db.prepare(`DELETE FROM release WHERE id = ?`).run(dropId);
  return carried;
}
