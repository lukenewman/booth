import type Database from 'better-sqlite3';
import { ulid } from 'ulid';
import type {
  EntityKind,
  SourceRelease,
  SourceTrack,
  SyncResult,
} from '../sources/types';
import { normalizeArtistAlbumYear, normalizeFilePath } from './normalize';

export interface CollateSummary {
  rowsIn: number;
  releasesUpserted: number;
  tracksUpserted: number;
  releasesDeleted: number;
  tracksDeleted: number;
  conflicts: number;
}

type MatchMethod =
  | 'file_path'
  | 'artist_album_year'
  | 'external_id_carryover'
  | 'first_seen';

/**
 * Run a single source's SyncResult against the DB:
 *   - upsert entities (track, release) and source_links via deterministic match keys
 *   - upsert source_facets
 *   - delete source_links whose external_ids are no longer present in this sync
 *   - delete entities that have zero remaining source_links
 */
export function collate(
  db: Database.Database,
  sourceId: string,
  result: SyncResult,
): CollateSummary {
  const summary: CollateSummary = {
    rowsIn: result.tracks.length + result.releases.length,
    releasesUpserted: 0,
    tracksUpserted: 0,
    releasesDeleted: 0,
    tracksDeleted: 0,
    conflicts: 0,
  };

  const tx = db.transaction(() => {
    // Cache of external_id → entity_id created/found during this run, so tracks
    // can resolve their releaseExternalId before the release row's source_link is committed.
    const releaseLookup = new Map<string, string>();

    for (const r of result.releases) {
      const entityId = upsertRelease(db, sourceId, r, summary);
      releaseLookup.set(r.externalId, entityId);
    }

    for (const t of result.tracks) {
      upsertTrack(db, sourceId, t, releaseLookup, summary);
    }

    // Diff: drop source_links from this source whose external_id is not in the
    // current sync, then drop orphan entities.
    const externalIds = new Set<string>([
      ...result.releases.map((r) => r.externalId),
      ...result.tracks.map((t) => t.externalId),
    ]);
    summary.releasesDeleted = pruneSource(db, 'release', sourceId, externalIds);
    summary.tracksDeleted = pruneSource(db, 'track', sourceId, externalIds);
  });

  tx();
  return summary;
}

// ---- Releases ---------------------------------------------------

function upsertRelease(
  db: Database.Database,
  sourceId: string,
  r: SourceRelease,
  summary: CollateSummary,
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

  if (!entityId) {
    entityId = ulid();
    db.prepare(
      `INSERT INTO release (id, title, artist, year, country, label, catno)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(entityId, r.title, r.artist, r.year ?? null, r.country ?? null, r.label ?? null, r.catno ?? null);
  } else {
    db.prepare(
      `UPDATE release
         SET title=?, artist=?, year=?, country=?, label=?, catno=?,
             updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id=?`,
    ).run(r.title, r.artist, r.year ?? null, r.country ?? null, r.label ?? null, r.catno ?? null, entityId);
  }

  upsertSourceLink(db, 'release', entityId, sourceId, r.externalId, r.externalUrl, method, summary);
  if (matchKey) upsertMatchKey(db, 'release', entityId, 'artist_album_year', matchKey);
  upsertFacets(db, 'release', entityId, sourceId, r.facets);

  summary.releasesUpserted++;
  return entityId;
}

// ---- Tracks -----------------------------------------------------

function upsertTrack(
  db: Database.Database,
  sourceId: string,
  t: SourceTrack,
  releaseLookup: Map<string, string>,
  summary: CollateSummary,
): string {
  const fp = t.filePath ? normalizeFilePath(t.filePath) : null;
  let entityId: string | undefined;
  let method: MatchMethod = 'first_seen';

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

  let releaseId: string | null = null;
  if (t.releaseExternalId) {
    releaseId = releaseLookup.get(t.releaseExternalId) ?? null;
    if (!releaseId) {
      // Look it up via source_link in case a previous run created it.
      const found = db
        .prepare(
          `SELECT entity_id FROM source_link
            WHERE entity_kind='release' AND source=? AND external_id=?`,
        )
        .get(sourceId, t.releaseExternalId) as { entity_id: string } | undefined;
      releaseId = found?.entity_id ?? null;
    }
  }

  if (!entityId) {
    entityId = ulid();
    db.prepare(
      `INSERT INTO track (id, title, artist, album, duration_ms, release_id, position)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      entityId,
      t.title,
      t.artist,
      t.album ?? null,
      t.durationMs ?? null,
      releaseId,
      t.position ?? null,
    );
  } else {
    db.prepare(
      `UPDATE track
         SET title=?, artist=?, album=?, duration_ms=?, release_id=?, position=?,
             updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id=?`,
    ).run(
      t.title,
      t.artist,
      t.album ?? null,
      t.durationMs ?? null,
      releaseId,
      t.position ?? null,
      entityId,
    );
  }

  upsertSourceLink(db, 'track', entityId, sourceId, t.externalId, t.externalUrl, method, summary);
  if (fp) upsertMatchKey(db, 'track', entityId, 'file_path', fp);
  upsertFacets(db, 'track', entityId, sourceId, t.facets);

  summary.tracksUpserted++;
  return entityId;
}

// ---- Shared helpers --------------------------------------------

function upsertSourceLink(
  db: Database.Database,
  kind: EntityKind,
  entityId: string,
  sourceId: string,
  externalId: string,
  externalUrl: string | undefined,
  method: MatchMethod,
  summary: CollateSummary,
): void {
  // Detect conflict: a row already exists for (kind, source, external_id) but it
  // points at a different entity_id than what our match logic just resolved.
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

  db.prepare(
    `INSERT INTO source_link (entity_kind, entity_id, source, external_id, external_url, match_method)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(entity_kind, source, external_id) DO UPDATE SET
       entity_id    = excluded.entity_id,
       external_url = excluded.external_url,
       match_method = excluded.match_method`,
  ).run(kind, entityId, sourceId, externalId, externalUrl ?? null, method);
}

function upsertMatchKey(
  db: Database.Database,
  kind: EntityKind,
  entityId: string,
  keyType: string,
  keyValue: string,
): void {
  // Two unique constraints on this table:
  //   PK   (entity_kind, key_type, key_value)  → "this key already maps to that entity"
  //   UQ   (entity_kind, entity_id, key_type)  → "this entity already has a key of this type"
  db.prepare(
    `INSERT INTO match_key (entity_kind, entity_id, key_type, key_value)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(entity_kind, key_type, key_value) DO UPDATE SET
       entity_id = excluded.entity_id`,
  ).run(kind, entityId, keyType, keyValue);
}

function upsertFacets(
  db: Database.Database,
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
  db: Database.Database,
  kind: EntityKind,
  sourceId: string,
  keepExternalIds: Set<string>,
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
