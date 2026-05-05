import type Database from 'better-sqlite3';

export function getMembershipExternalIds(
  db: Database.Database,
  source: string,
  entityKind: 'track' | 'release' = 'release',
): string[] {
  const rows = db
    .prepare(
      `SELECT external_id FROM source_link
        WHERE entity_kind=? AND source=?`,
    )
    .all(entityKind, source) as { external_id: string }[];
  return rows.map((r) => r.external_id);
}

export interface TrackRow {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  duration_ms: number | null;
  release_id: string | null;
  position: string | null;
  source_links: { source: string; external_id: string; external_url: string | null }[];
  facets: { source: string; key: string; value: unknown }[];
}

export interface ReleaseRow {
  id: string;
  title: string;
  artist: string;
  year: number | null;
  country: string | null;
  label: string | null;
  catno: string | null;
  source_links: { source: string; external_id: string; external_url: string | null }[];
  facets: { source: string; key: string; value: unknown }[];
}

export function listTracks(
  db: Database.Database,
  opts: { source?: string; limit: number },
): TrackRow[] {
  const ids = opts.source
    ? db
        .prepare(
          `SELECT entity_id FROM source_link
            WHERE entity_kind='track' AND source=?
            ORDER BY entity_id DESC LIMIT ?`,
        )
        .all(opts.source, opts.limit)
        .map((r: any) => r.entity_id)
    : db
        .prepare(`SELECT id FROM track ORDER BY id DESC LIMIT ?`)
        .all(opts.limit)
        .map((r: any) => r.id);
  return ids.map((id) => loadTrack(db, id)).filter((t): t is TrackRow => t !== null);
}

export function listReleases(
  db: Database.Database,
  opts: { source?: string; limit: number },
): ReleaseRow[] {
  const ids = opts.source
    ? db
        .prepare(
          `SELECT entity_id FROM source_link
            WHERE entity_kind='release' AND source=?
            ORDER BY entity_id DESC LIMIT ?`,
        )
        .all(opts.source, opts.limit)
        .map((r: any) => r.entity_id)
    : db
        .prepare(`SELECT id FROM release ORDER BY id DESC LIMIT ?`)
        .all(opts.limit)
        .map((r: any) => r.id);
  return ids.map((id) => loadRelease(db, id)).filter((r): r is ReleaseRow => r !== null);
}

function loadTrack(db: Database.Database, id: string): TrackRow | null {
  const row = db.prepare('SELECT * FROM track WHERE id=?').get(id) as any;
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    album: row.album,
    duration_ms: row.duration_ms,
    release_id: row.release_id,
    position: row.position,
    source_links: loadLinks(db, 'track', id),
    facets: loadFacets(db, 'track', id),
  };
}

function loadRelease(db: Database.Database, id: string): ReleaseRow | null {
  const row = db.prepare('SELECT * FROM release WHERE id=?').get(id) as any;
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    year: row.year,
    country: row.country,
    label: row.label,
    catno: row.catno,
    source_links: loadLinks(db, 'release', id),
    facets: loadFacets(db, 'release', id),
  };
}

function loadLinks(db: Database.Database, kind: 'track' | 'release', id: string) {
  return db
    .prepare(
      `SELECT source, external_id, external_url FROM source_link
        WHERE entity_kind=? AND entity_id=? ORDER BY source`,
    )
    .all(kind, id) as { source: string; external_id: string; external_url: string | null }[];
}

function loadFacets(db: Database.Database, kind: 'track' | 'release', id: string) {
  return (
    db
      .prepare(
        `SELECT source, key, value FROM source_facets
          WHERE entity_kind=? AND entity_id=? ORDER BY source, key`,
      )
      .all(kind, id) as { source: string; key: string; value: string }[]
  ).map((r) => ({ source: r.source, key: r.key, value: safeJson(r.value) }));
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
