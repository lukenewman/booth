import type { Database } from 'bun:sqlite';
import { ulid } from 'ulid';
import type {
  EntityKind,
  SourceRelease,
  SourceTrack,
  SyncResult,
} from '../sources/types';
import { normalizeArtistAlbumYear, normalizeArtistName, normalizeFilePath } from './normalize';

const UNKNOWN_ARTIST_NAME = '(unknown)';

export interface CollateSummary {
  rowsIn: number;
  releasesUpserted: number;
  tracksUpserted: number;
  releasesDeleted: number;
  tracksDeleted: number;
  conflicts: number;
  /**
   * Links whose external_id was rewritten in place because an authoritative
   * match proved the source had renumbered the same entity. Distinct from
   * `conflicts` — these were repaired, not skipped.
   */
  relinked: number;
}

export type MatchMethod =
  | 'file_path'
  | 'artist_album_year'
  | 'release_position'
  | 'external_id_carryover'
  | 'name_normalized'
  | 'first_seen';

/**
 * Run a single source's SyncResult against the DB:
 *   - upsert entities (track, release) and source_links via deterministic match keys
 *   - upsert source_facets
 *   - delete source_links whose external_ids are no longer present in this sync
 *   - delete entities that have zero remaining source_links
 */
export interface CollateOptions {
  /**
   * Absolute root of Booth's vinyl-rip recordings. When set, local-source
   * prunes skip external_ids under this root — an Apple Music XML re-sync
   * must never delete vinyl rips, which are absent from the XML by nature.
   */
  recordingsRoot?: string;
}

export function collate(
  db: Database,
  sourceId: string,
  result: SyncResult,
  opts: CollateOptions = {},
): CollateSummary {
  const summary: CollateSummary = {
    rowsIn: result.tracks.length + result.releases.length,
    releasesUpserted: 0,
    tracksUpserted: 0,
    releasesDeleted: 0,
    tracksDeleted: 0,
    conflicts: 0,
    relinked: 0,
  };

  const tx = db.transaction(() => {
    // Cache of external_id → entity_id created/found during this run, so tracks
    // can resolve their releaseExternalId before the release row's source_link is committed.
    const releaseLookup = new Map<string, string>();
    // Cache normalized artist name → artist_id for the duration of this sync.
    const artistCache = new Map<string, string>();

    for (const r of result.releases) {
      const entityId = upsertRelease(db, sourceId, r, summary, artistCache);
      releaseLookup.set(r.externalId, entityId);
    }

    for (const t of result.tracks) {
      upsertTrack(db, sourceId, t, releaseLookup, summary, artistCache);
    }

    // Diff: drop source_links from this source whose external_id is not in the
    // current sync, then drop orphan entities.
    // Guard: only prune a given entity kind when the sync actually provided
    // entities of that kind.  An empty result means "didn't fetch this kind"
    // (e.g. Discogs returns no tracks during the main collection sync), not
    // "delete everything" — so we skip the prune to avoid wiping rows that
    // were written by a separate hydration step.
    const externalIds = new Set<string>([
      ...result.releases.map((r) => r.externalId),
      ...result.tracks.map((t) => t.externalId),
    ]);
    const isVinylRip = (externalId: string): boolean =>
      sourceId === 'local' &&
      !!opts.recordingsRoot &&
      externalId.startsWith(opts.recordingsRoot);
    if (result.releases.length > 0) {
      summary.releasesDeleted = pruneSource(db, 'release', sourceId, externalIds, isVinylRip);
    }
    if (result.tracks.length > 0) {
      summary.tracksDeleted = pruneSource(db, 'track', sourceId, externalIds, isVinylRip);
    }

    db.prepare(
      `INSERT INTO source_state (source, last_synced_at, last_summary)
       VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?)
       ON CONFLICT(source) DO UPDATE SET
         last_synced_at = excluded.last_synced_at,
         last_summary   = excluded.last_summary`,
    ).run(sourceId, JSON.stringify(summary));
  });

  tx();
  return summary;
}

// ---- Artists ----------------------------------------------------

/**
 * Resolve a free-form artist name to an artist row id, creating one if needed.
 * Dedup strategy (in order):
 *   1. match_key lookup via squashAlphanumLower(name)
 *   2. fallback case-insensitive lookup against artist.name — covers artists
 *      backfilled by migration 003 before any match_key row exists
 *   3. insert a new artist row + its match_key
 *
 * Empty / whitespace names fall back to the "(unknown)" sentinel artist
 * (guaranteed to exist by migration 003).
 */
export function upsertArtist(
  db: Database,
  rawName: string,
  cache?: Map<string, string>,
): string {
  const name = rawName?.trim() ?? '';
  const normalized = normalizeArtistName(name);

  if (!normalized) {
    if (cache?.has('__unknown__')) return cache.get('__unknown__')!;
    const sentinel = db
      .prepare(`SELECT id FROM artist WHERE name = ? LIMIT 1`)
      .get(UNKNOWN_ARTIST_NAME) as { id: string } | undefined;
    if (sentinel) {
      cache?.set('__unknown__', sentinel.id);
      return sentinel.id;
    }
    // No sentinel (e.g. running against a freshly-migrated empty DB) — create one.
    const id = ulid();
    db.prepare(`INSERT INTO artist (id, name) VALUES (?, ?)`).run(id, UNKNOWN_ARTIST_NAME);
    cache?.set('__unknown__', id);
    return id;
  }

  if (cache?.has(normalized)) return cache.get(normalized)!;

  // 1. match_key lookup
  const byKey = db
    .prepare(
      `SELECT entity_id FROM match_key
        WHERE entity_kind='artist' AND key_type='name_normalized' AND key_value=?`,
    )
    .get(normalized) as { entity_id: string } | undefined;
  if (byKey) {
    cache?.set(normalized, byKey.entity_id);
    return byKey.entity_id;
  }

  // 2. fallback: case-insensitive name lookup (catches migration-backfilled rows)
  const byName = db
    .prepare(`SELECT id FROM artist WHERE LOWER(name) = LOWER(?) LIMIT 1`)
    .get(name) as { id: string } | undefined;
  if (byName) {
    upsertMatchKey(db, 'artist', byName.id, 'name_normalized', normalized);
    cache?.set(normalized, byName.id);
    return byName.id;
  }

  // 3. new artist row
  const id = ulid();
  db.prepare(`INSERT INTO artist (id, name) VALUES (?, ?)`).run(id, name);
  upsertMatchKey(db, 'artist', id, 'name_normalized', normalized);
  cache?.set(normalized, id);
  return id;
}

// ---- Releases ---------------------------------------------------

function upsertRelease(
  db: Database,
  sourceId: string,
  r: SourceRelease,
  summary: CollateSummary,
  artistCache: Map<string, string>,
): string {
  const matchKey = normalizeArtistAlbumYear({
    artist: r.artist,
    album: r.title,
    year: r.year,
  });

  let entityId: string | undefined;
  let method: MatchMethod = 'first_seen';

  if (matchKey) {
    const found = db
      .prepare(
        `SELECT entity_id FROM match_key
          WHERE entity_kind='release' AND key_type='artist_album_year' AND key_value=?`,
      )
      .get(matchKey) as { entity_id: string } | undefined;
    if (found) {
      entityId = found.entity_id;
      method = 'artist_album_year';
    }
  }

  if (!entityId) {
    const carry = db
      .prepare(
        `SELECT entity_id FROM source_link
          WHERE entity_kind='release' AND source=? AND external_id=?`,
      )
      .get(sourceId, r.externalId) as { entity_id: string } | undefined;
    if (carry) {
      entityId = carry.entity_id;
      method = 'external_id_carryover';
    }
  }

  const artistId = upsertArtist(db, r.artist, artistCache);

  if (!entityId) {
    entityId = ulid();
    db.prepare(
      `INSERT INTO release (id, title, artist_id, year, country, label, catno, thumb_url, cover_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(entityId, r.title, artistId, r.year ?? null, r.country ?? null, r.label ?? null, r.catno ?? null, r.thumbUrl ?? null, r.coverUrl ?? null);
  } else {
    db.prepare(
      `UPDATE release
         SET title=?, artist_id=?, year=?, country=?, label=?, catno=?,
             thumb_url=COALESCE(?, thumb_url),
             cover_url=COALESCE(?, cover_url),
             updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id=?`,
    ).run(r.title, artistId, r.year ?? null, r.country ?? null, r.label ?? null, r.catno ?? null, r.thumbUrl ?? null, r.coverUrl ?? null, entityId);
  }

  upsertSourceLink(db, 'release', entityId, sourceId, r.externalId, r.externalUrl, method, summary);
  if (matchKey) upsertMatchKey(db, 'release', entityId, 'artist_album_year', matchKey);
  upsertFacets(db, 'release', entityId, sourceId, r.facets);

  summary.releasesUpserted++;
  return entityId;
}

// ---- Tracks -----------------------------------------------------

function upsertTrack(
  db: Database,
  sourceId: string,
  t: SourceTrack,
  releaseLookup: Map<string, string>,
  summary: CollateSummary,
  artistCache: Map<string, string>,
): string {
  const fp = t.filePath ? normalizeFilePath(t.filePath) : null;
  let entityId: string | undefined;
  let method: MatchMethod = 'first_seen';

  // Resolve releaseId early — needed for the release_position match key lookup.
  let releaseId: string | null = null;
  if (t.releaseExternalId) {
    releaseId = releaseLookup.get(t.releaseExternalId) ?? null;
    if (!releaseId) {
      const found = db
        .prepare(
          `SELECT entity_id FROM source_link
            WHERE entity_kind='release' AND source=? AND external_id=?`,
        )
        .get(sourceId, t.releaseExternalId) as { entity_id: string } | undefined;
      releaseId = found?.entity_id ?? null;
    }
  }

  // 1. File-path match (iTunes-specific, most authoritative for local tracks).
  if (fp) {
    const found = db
      .prepare(
        `SELECT entity_id FROM match_key
          WHERE entity_kind='track' AND key_type='file_path' AND key_value=?`,
      )
      .get(fp) as { entity_id: string } | undefined;
    if (found) {
      entityId = found.entity_id;
      method = 'file_path';
    }
  }

  // 2. Release-position match — cross-source dedup when both Discogs and iTunes
  //    contribute tracks for the same canonical release. Key: "{releaseId}:{pos}".
  if (!entityId && releaseId && t.position) {
    const posNum = parseInt(t.position, 10);
    if (!isNaN(posNum) && posNum > 0) {
      const found = db
        .prepare(
          `SELECT entity_id FROM match_key
            WHERE entity_kind='track' AND key_type='release_position' AND key_value=?`,
        )
        .get(`${releaseId}:${posNum}`) as { entity_id: string } | undefined;
      if (found) {
        entityId = found.entity_id;
        method = 'release_position';
      }
    }
  }

  // 3. External-ID carryover — same source, same external_id from a previous sync.
  if (!entityId) {
    const carry = db
      .prepare(
        `SELECT entity_id FROM source_link
          WHERE entity_kind='track' AND source=? AND external_id=?`,
      )
      .get(sourceId, t.externalId) as { entity_id: string } | undefined;
    if (carry) {
      entityId = carry.entity_id;
      method = 'external_id_carryover';
    }
  }

  const artistId = upsertArtist(db, t.artist, artistCache);

  if (!entityId) {
    entityId = ulid();
    db.prepare(
      `INSERT INTO track (id, title, artist_id, album, duration_ms, release_id, position)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      entityId,
      t.title,
      artistId,
      t.album ?? null,
      t.durationMs ?? null,
      releaseId,
      t.position ?? null,
    );
  } else {
    db.prepare(
      `UPDATE track
         SET title=?, artist_id=?, album=?, duration_ms=?, release_id=?, position=?,
             updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id=?`,
    ).run(
      t.title,
      artistId,
      t.album ?? null,
      t.durationMs ?? null,
      releaseId,
      t.position ?? null,
      entityId,
    );
  }

  upsertSourceLink(db, 'track', entityId, sourceId, t.externalId, t.externalUrl, method, summary);
  if (fp) upsertMatchKey(db, 'track', entityId, 'file_path', fp);
  // Write release_position key so future cross-source syncs can find this entity.
  if (releaseId && t.position) {
    const posNum = parseInt(t.position, 10);
    if (!isNaN(posNum) && posNum > 0) {
      upsertMatchKey(db, 'track', entityId, 'release_position', `${releaseId}:${posNum}`);
    }
  }
  upsertFacets(db, 'track', entityId, sourceId, t.facets);

  summary.tracksUpserted++;
  return entityId;
}

// ---- Shared helpers --------------------------------------------

export function upsertSourceLink(
  db: Database,
  kind: EntityKind,
  entityId: string,
  sourceId: string,
  externalId: string,
  externalUrl: string | undefined,
  method: MatchMethod,
  summary: CollateSummary,
): void {
  // Detect PK conflict: a row already exists for (kind, source, external_id) but
  // it points at a different entity_id than what our match logic just resolved.
  const existing = db
    .prepare(
      `SELECT entity_id FROM source_link
        WHERE entity_kind=? AND source=? AND external_id=?`,
    )
    .get(kind, sourceId, externalId) as { entity_id: string } | undefined;
  if (existing && existing.entity_id !== entityId) {
    summary.conflicts++;
    return; // leave existing alone in Slice 1
  }

  // This source already has a link to this entity via a different external_id.
  // Two very different situations land here:
  //
  //   a) The source renumbered a record we can still identify with certainty —
  //      a `file_path` match means this is byte-for-byte the same file on disk,
  //      so the id simply moved. Rewrite the link in place.
  //   b) Anything weaker (release_position, artist_album_year) is genuinely
  //      ambiguous — two source records competing for one entity. Leave the
  //      existing link alone and count it.
  //
  // Case (a) used to fall into (b): Music.app renumbers Track IDs on purge or
  // re-export, the update was skipped, and the following prune then deleted the
  // now-unreferenced link *and the entity behind it*. That silently destroyed
  // 924 tracks on 2026-08-14 before local switched to Persistent ID.
  const existingByEntity = db
    .prepare(
      `SELECT external_id FROM source_link
        WHERE entity_kind=? AND entity_id=? AND source=?`,
    )
    .get(kind, entityId, sourceId) as { external_id: string } | undefined;
  if (existingByEntity && existingByEntity.external_id !== externalId) {
    if (method !== 'file_path') {
      summary.conflicts++;
      return;
    }
    db.prepare(
      `UPDATE source_link
          SET external_id  = ?,
              external_url = ?,
              match_method = ?
        WHERE entity_kind=? AND entity_id=? AND source=?`,
    ).run(externalId, externalUrl ?? null, method, kind, entityId, sourceId);
    summary.relinked++;
    return;
  }

  db.prepare(
    `INSERT INTO source_link (entity_kind, entity_id, source, external_id, external_url, match_method)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(entity_kind, source, external_id) DO UPDATE SET
       entity_id    = excluded.entity_id,
       external_url = excluded.external_url,
       match_method = excluded.match_method`,
  ).run(kind, entityId, sourceId, externalId, externalUrl ?? null, method);
}

export function upsertMatchKey(
  db: Database,
  kind: EntityKind,
  entityId: string,
  keyType: string,
  keyValue: string,
): void {
  // Two unique constraints on this table:
  //   PK   (entity_kind, key_type, key_value)  → "this key already maps to that entity"
  //   UQ   (entity_kind, entity_id, key_type)  → "this entity already has a key of this type"
  //
  // If the entity's key value changed (e.g. artist name updated between syncs), the stale
  // row must be removed first — the ON CONFLICT below only targets the PK, not the UQ.
  db.prepare(
    `DELETE FROM match_key WHERE entity_kind=? AND entity_id=? AND key_type=? AND key_value!=?`,
  ).run(kind, entityId, keyType, keyValue);
  db.prepare(
    `INSERT INTO match_key (entity_kind, entity_id, key_type, key_value)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(entity_kind, key_type, key_value) DO UPDATE SET
       entity_id = excluded.entity_id`,
  ).run(kind, entityId, keyType, keyValue);
}

export function upsertFacets(
  db: Database,
  kind: EntityKind,
  entityId: string,
  sourceId: string,
  facets: Record<string, unknown> | undefined,
): void {
  if (!facets) return;
  const stmt = db.prepare(
    `INSERT INTO source_facets (entity_kind, entity_id, source, key, value)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(entity_kind, entity_id, source, key) DO UPDATE SET
       value      = excluded.value,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  );
  for (const [key, val] of Object.entries(facets)) {
    if (val === undefined) continue;
    stmt.run(kind, entityId, sourceId, key, JSON.stringify(val));
  }
}

function pruneSource(
  db: Database,
  kind: EntityKind,
  sourceId: string,
  keepExternalIds: Set<string>,
  keepPredicate?: (externalId: string) => boolean,
): number {
  const toDelete = db
    .prepare(
      `SELECT entity_id, external_id FROM source_link
        WHERE entity_kind=? AND source=?`,
    )
    .all(kind, sourceId) as { entity_id: string; external_id: string }[];

  let orphans = 0;
  for (const row of toDelete) {
    if (keepExternalIds.has(row.external_id)) continue;
    if (keepPredicate?.(row.external_id)) continue;
    db.prepare(
      `DELETE FROM source_link
        WHERE entity_kind=? AND source=? AND external_id=?`,
    ).run(kind, sourceId, row.external_id);
    const remaining = db
      .prepare(
        `SELECT 1 FROM source_link WHERE entity_kind=? AND entity_id=? LIMIT 1`,
      )
      .get(kind, row.entity_id);
    if (!remaining) {
      const table = kind === 'track' ? 'track' : 'release';
      db.prepare(`DELETE FROM ${table} WHERE id=?`).run(row.entity_id);
      db.prepare(
        `DELETE FROM match_key WHERE entity_kind=? AND entity_id=?`,
      ).run(kind, row.entity_id);
      db.prepare(
        `DELETE FROM source_facets WHERE entity_kind=? AND entity_id=?`,
      ).run(kind, row.entity_id);
      orphans++;
    }
  }
  return orphans;
}
