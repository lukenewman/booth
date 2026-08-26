import type { Database } from 'bun:sqlite';
import type { EntityKind } from '../sources/types';
import { DEFAULT_SORT, type SortKey } from '$lib/types';
import { listSources } from '../sources/registry';
import { isPlayable } from '../sources/types';

// Computed once at module load — source registry is static.
const playableSources = new Set(
  listSources().filter(isPlayable).map((s) => s.id),
);

import { countStarredByRelease } from './annotations';

export function getMembershipExternalIds(
  db: Database,
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
  thumb_url: string | null;
  cover_url: string | null;
  vetted_at: string | null;
}

export interface TrackRow {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  duration_ms: number | null;
  release_id: string | null;
  position: string | null;
  thumb_url: string | null;
  starred_at: string | null;
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

export type { SortKey };

/** An absent or unrecognised `?sort=` means the app default, not artist order. */
export function parseSort(raw: string | null | undefined): SortKey {
  return raw === 'added-desc' || raw === 'added-asc' || raw === 'artist' ? raw : DEFAULT_SORT;
}

/**
 * `dateAdded` is stored JSON-encoded, so values carry literal quotes
 * (`"2026-08-11T15:01:07.000Z"`). ISO-8601 sorts correctly as text and the
 * leading quote is a constant prefix, so the raw value orders fine as-is.
 *
 * Every clause ends in the entity's ULID. That is not cosmetic: the library
 * averages ~9 tracks per distinct timestamp (one bucket holds 66), and the
 * listview pages with LIMIT/OFFSET. Without a unique final key SQLite may
 * order tied rows differently between page requests, which shows up as rows
 * repeating or vanishing while scrolling.
 *
 * NULLs (entities with no local file — e.g. Discogs-only) sort last in BOTH
 * directions, so flipping to oldest-first doesn't bury the library under
 * undated rows.
 */
function addedOrderClause(sort: 'added-desc' | 'added-asc', addedCol: string, idCol: string): string {
  const dir = sort === 'added-desc' ? 'DESC' : 'ASC';
  return `${addedCol} IS NULL, ${addedCol} ${dir}, ${idCol} ${dir}`;
}

interface ListReleasesArgs {
  source?: string;
  q?: string;
  limit: number;
  offset: number;
  multiSource?: boolean;
  sort?: SortKey;
  vetted?: boolean;
}

export function listReleases(
  db: Database,
  args: ListReleasesArgs,
): PagedResult<ReleaseRow & { sources: string[]; starredCount: number }> {
  const where: string[] = [];
  const params: string[] = [];

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
  if (args.vetted !== undefined) {
    where.push(args.vetted ? `release.vetted_at IS NOT NULL` : `release.vetted_at IS NULL`);
  }
  if (args.q) {
    where.push(`(release.title LIKE ? OR artist.name LIKE ?)`);
    params.push(`%${args.q}%`, `%${args.q}%`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const totalRow = db
    .prepare(
      `SELECT COUNT(*) as n FROM release
         JOIN artist ON artist.id = release.artist_id
         ${whereSql}`,
    )
    .get(...params) as { n: number };

  // A release has no date of its own — `dateAdded` is per track — so it takes
  // the EARLIEST of its tracks: when the record first entered the library,
  // which is what lines up with a purchase date. A later top-up (bonus track,
  // re-rip) must not move an old record to the top of "recently added".
  // The join is only paid for when actually sorting by it.
  const sort = args.sort ?? DEFAULT_SORT;
  const addedJoin =
    sort === 'artist'
      ? ''
      : `LEFT JOIN (
           SELECT t.release_id AS rid, MIN(sf.value) AS added
             FROM track t
             JOIN source_facets sf
               ON sf.entity_kind='track' AND sf.entity_id = t.id
              AND sf.source='local' AND sf.key='dateAdded'
            WHERE t.release_id IS NOT NULL
            GROUP BY t.release_id
         ) ra ON ra.rid = release.id`;
  const orderSql =
    sort === 'artist'
      ? `artist.name COLLATE NOCASE, release.year, release.title COLLATE NOCASE`
      : addedOrderClause(sort, 'ra.added', 'release.id');

  const rows = db
    .prepare(
      `SELECT release.id, release.title, artist.name AS artist,
              release.year, release.country, release.label, release.catno,
              release.thumb_url, release.cover_url, release.vetted_at
         FROM release
         JOIN artist ON artist.id = release.artist_id
         ${addedJoin}
         ${whereSql}
         ORDER BY ${orderSql}
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

  // Batched like sourcesByEntity above: one extra round-trip per page rather
  // than a correlated subquery per row, and it leaves the ORDER BY … LIMIT
  // query untouched.
  const starCounts = countStarredByRelease(db, ids);

  return {
    items: rows.map((r) => ({
      ...r,
      sources: sourceMap.get(r.id) ?? [],
      starredCount: starCounts.get(r.id) ?? 0,
    })),
    total: totalRow.n,
    hasMore: args.offset + rows.length < totalRow.n,
  };
}

export interface TrackFilterArgs {
  source?: string;
  q?: string;
  multiSource?: boolean;
  sort?: SortKey;
  starred?: boolean;
}

/**
 * The WHERE/JOIN/ORDER for a track listing. Shared verbatim by `listTracks` and
 * `listTrackIds` — the queue depends on the two producing identical ordering,
 * so this must never be duplicated into two drifting copies.
 */
function buildTrackQuery(args: TrackFilterArgs): {
  whereSql: string;
  params: string[];
  addedJoin: string;
  orderSql: string;
} {
  const where: string[] = [];
  const params: string[] = [];

  if (args.source) {
    where.push(
      `track.id IN (SELECT entity_id FROM source_link WHERE entity_kind='track' AND source=?)`,
    );
    params.push(args.source);
  }
  if (args.multiSource) {
    where.push(
      `track.id IN (
         SELECT entity_id FROM source_link
         WHERE entity_kind='track'
         GROUP BY entity_id
         HAVING COUNT(DISTINCT source) >= 2
       )`,
    );
  }
  if (args.starred !== undefined) {
    where.push(args.starred ? `track.starred_at IS NOT NULL` : `track.starred_at IS NULL`);
  }
  if (args.q) {
    where.push(`(track.title LIKE ? OR artist.name LIKE ? OR track.album LIKE ?)`);
    params.push(`%${args.q}%`, `%${args.q}%`, `%${args.q}%`);
  }

  const sort = args.sort ?? DEFAULT_SORT;
  const addedJoin =
    sort === 'artist'
      ? ''
      : `LEFT JOIN source_facets ta
           ON ta.entity_kind='track' AND ta.entity_id = track.id
          AND ta.source='local' AND ta.key='dateAdded'`;
  const orderSql =
    sort === 'artist'
      ? `artist.name COLLATE NOCASE, track.album COLLATE NOCASE, track.title COLLATE NOCASE`
      : addedOrderClause(sort, 'ta.value', 'track.id');

  return {
    whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '',
    params,
    addedJoin,
    orderSql,
  };
}

interface ListTracksArgs extends TrackFilterArgs {
  limit: number;
  offset: number;
}

export function listTracks(
  db: Database,
  args: ListTracksArgs,
): PagedResult<TrackRow & { sources: string[]; canPlay: boolean }> {
  const { whereSql, params, addedJoin, orderSql } = buildTrackQuery(args);

  const totalRow = db
    .prepare(
      `SELECT COUNT(*) as n FROM track
         JOIN artist ON artist.id = track.artist_id
         ${whereSql}`,
    )
    .get(...params) as { n: number };

  // At most one row per (entity, source, key), so the added-join can't multiply rows.
  const rows = db
    .prepare(
      `SELECT track.id, track.title, artist.name AS artist,
              track.album, track.duration_ms, track.release_id, track.position,
              release.thumb_url, track.starred_at
         FROM track
         JOIN artist ON artist.id = track.artist_id
         LEFT JOIN release ON release.id = track.release_id
         ${addedJoin}
         ${whereSql}
         ORDER BY ${orderSql}
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
    items: rows.map((r) => {
      const sources = sourceMap.get(r.id) ?? [];
      return { ...r, sources, canPlay: sources.some((s) => playableSources.has(s)) };
    }),
    total: totalRow.n,
    hasMore: args.offset + rows.length < totalRow.n,
  };
}

export function getReleaseDetail(
  db: Database,
  id: string,
): {
  release: ReleaseRow & { artist_id: string };
  sources: SourceLinkRow[];
  facets: SourceFacetRow[];
  tracks: Array<TrackRow & { sources: string[]; canPlay: boolean }>;
} | null {
  const release = db
    .prepare(
      `SELECT release.id, release.title, artist.name AS artist,
              release.artist_id,
              release.year, release.country, release.label, release.catno,
              release.thumb_url, release.cover_url
         FROM release
         JOIN artist ON artist.id = release.artist_id
         WHERE release.id = ?`,
    )
    .get(id) as (ReleaseRow & { artist_id: string }) | undefined;
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
      `SELECT track.id, track.title, artist.name AS artist,
              track.album, track.duration_ms, track.release_id, track.position
         FROM track
         JOIN artist ON artist.id = track.artist_id
         WHERE track.release_id = ?
         ORDER BY track.position IS NULL, CAST(track.position AS INTEGER), track.title COLLATE NOCASE`,
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
    tracks: tracks.map((t) => {
      const sources = trackSourceMap.get(t.id) ?? [];
      return { ...t, sources, canPlay: sources.some((s) => playableSources.has(s)) };
    }),
  };
}

export function getTrackDetail(
  db: Database,
  id: string,
): {
  track: TrackRow;
  sources: SourceLinkRow[];
  facets: SourceFacetRow[];
  release: ReleaseRow | null;
} | null {
  const track = db
    .prepare(
      `SELECT track.id, track.title, artist.name AS artist,
              track.album, track.duration_ms, track.release_id, track.position
         FROM track
         JOIN artist ON artist.id = track.artist_id
         WHERE track.id = ?`,
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
          `SELECT release.id, release.title, artist.name AS artist,
                  release.year, release.country, release.label, release.catno,
                  release.thumb_url, release.cover_url
             FROM release
             JOIN artist ON artist.id = release.artist_id
             WHERE release.id = ?`,
        )
        .get(track.release_id) as ReleaseRow | undefined) ?? null;
  }

  return { track, sources, facets, release };
}

// ---- Artists -----------------------------------------------------

export interface ArtistRow {
  id: string;
  name: string;
}

/**
 * Every track id matching these filters, in listview order, restricted to
 * tracks that can actually play. Unpaginated by design: the queue's whole
 * purpose is to run past the 200 rows the client has loaded.
 */
export function listTrackIds(db: Database, args: TrackFilterArgs): string[] {
  const { whereSql, params, addedJoin, orderSql } = buildTrackQuery(args);

  const playable = [...playableSources];
  if (playable.length === 0) return [];
  const playableClause = `track.id IN (
      SELECT entity_id FROM source_link
       WHERE entity_kind='track' AND source IN (${playable.map(() => '?').join(',')})
    )`;
  const combinedWhere = whereSql
    ? `${whereSql} AND ${playableClause}`
    : `WHERE ${playableClause}`;

  const rows = db
    .prepare(
      `SELECT track.id
         FROM track
         JOIN artist ON artist.id = track.artist_id
         ${addedJoin}
         ${combinedWhere}
         ORDER BY ${orderSql}`,
    )
    .all(...params, ...playable) as { id: string }[];
  return rows.map((r) => r.id);
}

interface ListArtistsArgs {
  source?: string;
  q?: string;
  limit: number;
  offset: number;
  multiSource?: boolean;
}

export interface ArtistListItem extends ArtistRow {
  releaseCount: number;
  trackCount: number;
  sources: string[];
  albums: { title: string; thumbUrl: string | null }[];
}

export function listArtists(
  db: Database,
  args: ListArtistsArgs,
): PagedResult<ArtistListItem> {
  // An artist's "sources" are the union of sources contributing to that
  // artist's releases and tracks. The Sources rail filter therefore checks
  // whether any release- or track-side source_link with this source exists
  // for the artist's child entities.
  const where: string[] = [];
  const params: string[] = [];

  if (args.source) {
    where.push(
      `(EXISTS (
         SELECT 1 FROM release r
           JOIN source_link sl
             ON sl.entity_kind='release' AND sl.entity_id=r.id
          WHERE r.artist_id = artist.id AND sl.source = ?
       )
       OR EXISTS (
         SELECT 1 FROM track t
           JOIN source_link sl
             ON sl.entity_kind='track' AND sl.entity_id=t.id
          WHERE t.artist_id = artist.id AND sl.source = ?
       ))`,
    );
    params.push(args.source, args.source);
  }
  if (args.multiSource) {
    where.push(
      `(
        SELECT COUNT(DISTINCT sl.source) FROM source_link sl
          WHERE (sl.entity_kind='release'
                  AND sl.entity_id IN (SELECT id FROM release WHERE artist_id = artist.id))
             OR (sl.entity_kind='track'
                  AND sl.entity_id IN (SELECT id FROM track   WHERE artist_id = artist.id))
       ) >= 2`,
    );
  }
  if (args.q) {
    where.push(`artist.name LIKE ?`);
    params.push(`%${args.q}%`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const totalRow = db
    .prepare(`SELECT COUNT(*) as n FROM artist ${whereSql}`)
    .get(...params) as { n: number };

  const rows = db
    .prepare(
      `SELECT
         artist.id,
         artist.name,
         (SELECT COUNT(*) FROM release r WHERE r.artist_id = artist.id) AS releaseCount,
         (SELECT COUNT(*) FROM track   t WHERE t.artist_id = artist.id) AS trackCount
       FROM artist
       ${whereSql}
       ORDER BY artist.name COLLATE NOCASE
       LIMIT ? OFFSET ?`,
    )
    .all(...params, args.limit, args.offset) as Array<ArtistRow & { releaseCount: number; trackCount: number }>;

  const ids = rows.map((r) => r.id);
  const sourceMap = new Map<string, Set<string>>();
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    const linkRows = db
      .prepare(
        `SELECT a.id AS artist_id, sl.source AS source
           FROM artist a
           LEFT JOIN release r ON r.artist_id = a.id
           LEFT JOIN track   t ON t.artist_id = a.id
           JOIN source_link sl
             ON (sl.entity_kind='release' AND sl.entity_id = r.id)
             OR (sl.entity_kind='track'   AND sl.entity_id = t.id)
          WHERE a.id IN (${placeholders})`,
      )
      .all(...ids) as Array<{ artist_id: string; source: string }>;
    for (const { artist_id, source } of linkRows) {
      const set = sourceMap.get(artist_id) ?? new Set<string>();
      set.add(source);
      sourceMap.set(artist_id, set);
    }
  }

  const albumMap = new Map<string, { title: string; thumbUrl: string | null }[]>();
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    const albumRows = db
      .prepare(
        `SELECT for_artist, title, thumb_url FROM (
           SELECT r.artist_id AS for_artist, r.id AS release_id, r.title, r.thumb_url, r.year
             FROM release r
            WHERE r.artist_id IN (${placeholders})
           UNION
           SELECT t.artist_id AS for_artist, r.id AS release_id, r.title, r.thumb_url, r.year
             FROM track t
             JOIN release r ON r.id = t.release_id
            WHERE t.artist_id IN (${placeholders}) AND t.release_id IS NOT NULL
         )
         ORDER BY COALESCE(year, 9999999), title COLLATE NOCASE`,
      )
      .all(...ids, ...ids) as Array<{ for_artist: string; title: string; thumb_url: string | null }>;
    for (const { for_artist, title, thumb_url } of albumRows) {
      const list = albumMap.get(for_artist) ?? [];
      list.push({ title, thumbUrl: thumb_url });
      albumMap.set(for_artist, list);
    }
  }

  return {
    items: rows.map((r) => ({
      ...r,
      sources: Array.from(sourceMap.get(r.id) ?? []),
      albums: albumMap.get(r.id) ?? [],
    })),
    total: totalRow.n,
    hasMore: args.offset + rows.length < totalRow.n,
  };
}

export interface ArtistDetail {
  artist: ArtistRow;
  sources: SourceLinkRow[];
  facets: SourceFacetRow[];
  releases: Array<ReleaseRow & { sources: string[] }>;
  trackCount: number;
}

/**
 * Fetch tracks by id in the shared list shape (artist joined, canPlay computed).
 * Returned as a Map keyed by track id so callers can re-order as they like
 * (e.g. playlists order by their own `position`). Unknown ids are absent.
 */
export type TrackRowWithRefs = TrackRow & { sources: string[]; canPlay: boolean; artist_id: string };

export function getTracksByIds(
  db: Database,
  ids: string[],
): Map<string, TrackRowWithRefs> {
  const out = new Map<string, TrackRowWithRefs>();
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => '?').join(',');

  const rows = db
    .prepare(
      `SELECT track.id, track.title, artist.name AS artist, track.artist_id,
              track.album, track.duration_ms, track.release_id, track.position,
              release.thumb_url
         FROM track
         JOIN artist ON artist.id = track.artist_id
         LEFT JOIN release ON release.id = track.release_id
         WHERE track.id IN (${placeholders})`,
    )
    .all(...ids) as (TrackRow & { artist_id: string })[];

  const srcRows = db
    .prepare(
      `SELECT entity_id, source FROM source_link
         WHERE entity_kind='track' AND entity_id IN (${placeholders})`,
    )
    .all(...ids) as { entity_id: string; source: string }[];

  const sourceMap = new Map<string, string[]>();
  for (const { entity_id, source } of srcRows) {
    const list = sourceMap.get(entity_id) ?? [];
    list.push(source);
    sourceMap.set(entity_id, list);
  }

  for (const r of rows) {
    const sources = sourceMap.get(r.id) ?? [];
    out.set(r.id, { ...r, sources, canPlay: sources.some((s) => playableSources.has(s)) });
  }
  return out;
}

export function getArtistDetail(db: Database, id: string): ArtistDetail | null {
  const artist = db
    .prepare(`SELECT id, name FROM artist WHERE id = ?`)
    .get(id) as ArtistRow | undefined;
  if (!artist) return null;

  // Artist-level source_link / source_facets are entity_kind='artist'.
  // Adapters don't emit these yet (BOO-28 plumbing only), but the schema
  // supports it — pre-wire the detail pane so future adapters drop in
  // without further changes.
  const sources = db
    .prepare(
      `SELECT source, external_id, external_url, match_method
         FROM source_link WHERE entity_kind='artist' AND entity_id = ?`,
    )
    .all(id) as SourceLinkRow[];

  const facets = db
    .prepare(
      `SELECT source, key, value
         FROM source_facets WHERE entity_kind='artist' AND entity_id = ?`,
    )
    .all(id) as SourceFacetRow[];

  const releases = db
    .prepare(
      `SELECT release.id, release.title, artist.name AS artist,
              release.year, release.country, release.label, release.catno,
              release.thumb_url, release.cover_url
         FROM release
         JOIN artist ON artist.id = release.artist_id
         WHERE release.artist_id = ?
         ORDER BY release.year, release.title COLLATE NOCASE`,
    )
    .all(id) as ReleaseRow[];

  const releaseIds = releases.map((r) => r.id);
  const sourceMap = new Map<string, string[]>();
  if (releaseIds.length) {
    const placeholders = releaseIds.map(() => '?').join(',');
    const linkRows = db
      .prepare(
        `SELECT entity_id, source FROM source_link
           WHERE entity_kind='release' AND entity_id IN (${placeholders})`,
      )
      .all(...releaseIds) as Array<{ entity_id: string; source: string }>;
    for (const { entity_id, source } of linkRows) {
      const list = sourceMap.get(entity_id) ?? [];
      list.push(source);
      sourceMap.set(entity_id, list);
    }
  }

  const trackCountRow = db
    .prepare(`SELECT COUNT(*) AS n FROM track WHERE artist_id = ?`)
    .get(id) as { n: number };

  return {
    artist,
    sources,
    facets,
    releases: releases.map((r) => ({ ...r, sources: sourceMap.get(r.id) ?? [] })),
    trackCount: trackCountRow.n,
  };
}

export interface SourceWithState {
  id: string;
  name: string;
  contributes: EntityKind[];
  isStub: boolean;
  count: number;
  lastSyncedAt: string | null;
  lastSummary: unknown | null;
}

export function listSourcesWithState(
  db: Database,
  registry: { id: string; name: string; contributes: EntityKind[]; isStub?: boolean }[],
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
