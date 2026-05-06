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

// Shared row types -------------------------------------------------

export interface ReleaseRow {
  id: string;
  title: string;
  artist: string;
  year: number | null;
  country: string | null;
  label: string | null;
  catno: string | null;
}

export interface TrackRow {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  duration_ms: number | null;
  release_id: string | null;
  position: string | null;
}

export interface SourceLinkRow {
  source: string;
  external_id: string;
  external_url: string | null;
  match_method: string;
}

export interface SourceFacetRow {
  source: string;
  key: string;
  value: string;
}

export interface PagedResult<T> {
  items: T[];
  total: number;
  hasMore: boolean;
}

// Helpers ----------------------------------------------------------

interface ListReleasesArgs {
  source?: string;
  q?: string;
  limit: number;
  offset: number;
  multiSource?: boolean;
}

export function listReleases(
  db: Database.Database,
  args: ListReleasesArgs,
): PagedResult<ReleaseRow & { sources: string[] }> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (args.source) {
    where.push(
      `release.id IN (SELECT entity_id FROM source_link WHERE entity_kind='release' AND source=?)`,
    );
    params.push(args.source);
  }
  if (args.multiSource) {
    where.push(
      `release.id IN (
         SELECT entity_id FROM source_link
         WHERE entity_kind='release'
         GROUP BY entity_id
         HAVING COUNT(DISTINCT source) >= 2
       )`,
    );
  }
  if (args.q) {
    where.push(`(release.title LIKE ? OR release.artist LIKE ?)`);
    params.push(`%${args.q}%`, `%${args.q}%`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const totalRow = db
    .prepare(`SELECT COUNT(*) as n FROM release ${whereSql}`)
    .get(...params) as { n: number };

  const rows = db
    .prepare(
      `SELECT id, title, artist, year, country, label, catno
         FROM release
         ${whereSql}
         ORDER BY artist COLLATE NOCASE, year, title COLLATE NOCASE
         LIMIT ? OFFSET ?`,
    )
    .all(...params, args.limit, args.offset) as ReleaseRow[];

  // Fetch source lists for the page in one round-trip.
  const ids = rows.map((r) => r.id);
  const sourcesByEntity = ids.length
    ? (db
        .prepare(
          `SELECT entity_id, source FROM source_link
             WHERE entity_kind='release' AND entity_id IN (${ids.map(() => '?').join(',')})`,
        )
        .all(...ids) as { entity_id: string; source: string }[])
    : [];

  const sourceMap = new Map<string, string[]>();
  for (const { entity_id, source } of sourcesByEntity) {
    const list = sourceMap.get(entity_id) ?? [];
    list.push(source);
    sourceMap.set(entity_id, list);
  }

  return {
    items: rows.map((r) => ({ ...r, sources: sourceMap.get(r.id) ?? [] })),
    total: totalRow.n,
    hasMore: args.offset + rows.length < totalRow.n,
  };
}

interface ListTracksArgs {
  source?: string;
  q?: string;
  limit: number;
  offset: number;
}

export function listTracks(
  db: Database.Database,
  args: ListTracksArgs,
): PagedResult<TrackRow & { sources: string[] }> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (args.source) {
    where.push(
      `track.id IN (SELECT entity_id FROM source_link WHERE entity_kind='track' AND source=?)`,
    );
    params.push(args.source);
  }
  if (args.q) {
    where.push(`(track.title LIKE ? OR track.artist LIKE ? OR track.album LIKE ?)`);
    params.push(`%${args.q}%`, `%${args.q}%`, `%${args.q}%`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const totalRow = db
    .prepare(`SELECT COUNT(*) as n FROM track ${whereSql}`)
    .get(...params) as { n: number };

  const rows = db
    .prepare(
      `SELECT id, title, artist, album, duration_ms, release_id, position
         FROM track
         ${whereSql}
         ORDER BY artist COLLATE NOCASE, album COLLATE NOCASE, title COLLATE NOCASE
         LIMIT ? OFFSET ?`,
    )
    .all(...params, args.limit, args.offset) as TrackRow[];

  const ids = rows.map((r) => r.id);
  const sourcesByEntity = ids.length
    ? (db
        .prepare(
          `SELECT entity_id, source FROM source_link
             WHERE entity_kind='track' AND entity_id IN (${ids.map(() => '?').join(',')})`,
        )
        .all(...ids) as { entity_id: string; source: string }[])
    : [];

  const sourceMap = new Map<string, string[]>();
  for (const { entity_id, source } of sourcesByEntity) {
    const list = sourceMap.get(entity_id) ?? [];
    list.push(source);
    sourceMap.set(entity_id, list);
  }

  return {
    items: rows.map((r) => ({ ...r, sources: sourceMap.get(r.id) ?? [] })),
    total: totalRow.n,
    hasMore: args.offset + rows.length < totalRow.n,
  };
}

export function getReleaseDetail(
  db: Database.Database,
  id: string,
): {
  release: ReleaseRow;
  sources: SourceLinkRow[];
  facets: SourceFacetRow[];
  tracks: Array<TrackRow & { sources: string[] }>;
} | null {
  const release = db
    .prepare(`SELECT id, title, artist, year, country, label, catno FROM release WHERE id = ?`)
    .get(id) as ReleaseRow | undefined;
  if (!release) return null;

  const sources = db
    .prepare(
      `SELECT source, external_id, external_url, match_method
         FROM source_link WHERE entity_kind='release' AND entity_id = ?`,
    )
    .all(id) as SourceLinkRow[];

  const facets = db
    .prepare(
      `SELECT source, key, value
         FROM source_facets WHERE entity_kind='release' AND entity_id = ?`,
    )
    .all(id) as SourceFacetRow[];

  const tracks = db
    .prepare(
      `SELECT id, title, artist, album, duration_ms, release_id, position
         FROM track WHERE release_id = ?
         ORDER BY position COLLATE NOCASE, title COLLATE NOCASE`,
    )
    .all(id) as TrackRow[];

  const trackIds = tracks.map((t) => t.id);
  const trackSources = trackIds.length
    ? (db
        .prepare(
          `SELECT entity_id, source FROM source_link
             WHERE entity_kind='track' AND entity_id IN (${trackIds.map(() => '?').join(',')})`,
        )
        .all(...trackIds) as { entity_id: string; source: string }[])
    : [];

  const trackSourceMap = new Map<string, string[]>();
  for (const { entity_id, source } of trackSources) {
    const list = trackSourceMap.get(entity_id) ?? [];
    list.push(source);
    trackSourceMap.set(entity_id, list);
  }

  return {
    release,
    sources,
    facets,
    tracks: tracks.map((t) => ({ ...t, sources: trackSourceMap.get(t.id) ?? [] })),
  };
}

export function getTrackDetail(
  db: Database.Database,
  id: string,
): {
  track: TrackRow;
  sources: SourceLinkRow[];
  facets: SourceFacetRow[];
  release: ReleaseRow | null;
} | null {
  const track = db
    .prepare(
      `SELECT id, title, artist, album, duration_ms, release_id, position
         FROM track WHERE id = ?`,
    )
    .get(id) as TrackRow | undefined;
  if (!track) return null;

  const sources = db
    .prepare(
      `SELECT source, external_id, external_url, match_method
         FROM source_link WHERE entity_kind='track' AND entity_id = ?`,
    )
    .all(id) as SourceLinkRow[];

  const facets = db
    .prepare(
      `SELECT source, key, value
         FROM source_facets WHERE entity_kind='track' AND entity_id = ?`,
    )
    .all(id) as SourceFacetRow[];

  let release: ReleaseRow | null = null;
  if (track.release_id) {
    release =
      (db
        .prepare(
          `SELECT id, title, artist, year, country, label, catno FROM release WHERE id = ?`,
        )
        .get(track.release_id) as ReleaseRow | undefined) ?? null;
  }

  return { track, sources, facets, release };
}

export interface SourceWithState {
  id: string;
  name: string;
  contributes: ('track' | 'release')[];
  isStub: boolean;
  count: number;
  lastSyncedAt: string | null;
  lastSummary: unknown | null;
}

export function listSourcesWithState(
  db: Database.Database,
  registry: { id: string; name: string; contributes: ('track' | 'release')[]; isStub?: boolean }[],
): SourceWithState[] {
  const counts = db
    .prepare(`SELECT source, COUNT(*) as n FROM source_link GROUP BY source`)
    .all() as { source: string; n: number }[];
  const countMap = new Map(counts.map((c) => [c.source, c.n]));

  const states = db
    .prepare(`SELECT source, last_synced_at, last_summary FROM source_state`)
    .all() as { source: string; last_synced_at: string; last_summary: string }[];
  const stateMap = new Map(states.map((s) => [s.source, s]));

  return registry.map((src) => {
    const state = stateMap.get(src.id);
    return {
      id: src.id,
      name: src.name,
      contributes: src.contributes,
      isStub: !!src.isStub,
      count: countMap.get(src.id) ?? 0,
      lastSyncedAt: state?.last_synced_at ?? null,
      lastSummary: state?.last_summary ? JSON.parse(state.last_summary) : null,
    };
  });
}
