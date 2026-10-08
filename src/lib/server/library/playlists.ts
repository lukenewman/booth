import type { Database } from 'bun:sqlite';
import { ulid } from 'ulid';
import { getTracksByIds, type TrackRow } from './queries';

export interface PlaylistSummary {
  id: string;
  name: string;
  /** Present tracks only — a missing entry is not something you can play. */
  trackCount: number;
  /** Custom uploaded cover, or null to fall back to the mosaic. */
  coverUrl: string | null;
  /** Up to 4 distinct release covers for the default mosaic (in playlist order). */
  mosaic: string[];
  isGig: boolean;
  targetMinutes: number | null;
}

export type PlaylistTrack = TrackRow & { sources: string[]; canPlay: boolean; artist_id: string };

export interface TrackSnapshot {
  artist: string;
  title: string;
  album: string | null;
  position: string | null;
}

/** One sketch row. `track` is null when the library no longer has it. */
export interface PlaylistEntry {
  entryId: string;
  sectionId: string;
  track: PlaylistTrack | null;
  snapshot: TrackSnapshot;
}

export interface PlaylistSection {
  id: string;
  name: string;
  isUnsorted: boolean;
  entries: PlaylistEntry[];
}

export interface CrateEntry {
  entryId: string;
  /** Null when the record has left the library; artist/title/year then come from the snapshot. */
  releaseId: string | null;
  artist: string;
  title: string;
  year: number | null;
  thumbUrl: string | null;
  sketchedCount: number;
}

export interface PlaylistDetail {
  id: string;
  name: string;
  coverUrl: string | null;
  mosaic: string[];
  targetMinutes: number | null;
  isGig: boolean;
  /** Present tracks, flattened in section order — what playback queues. */
  tracks: PlaylistTrack[];
  sections: PlaylistSection[];
  crate: CrateEntry[];
}

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

/**
 * A playlist is a gig once it has a crate, a second section, or a target
 * length. Derived, never stored, so there is no flag to drift out of sync.
 */
const IS_GIG = `(playlist.target_minutes IS NOT NULL
  OR EXISTS (SELECT 1 FROM playlist_release WHERE playlist_id = playlist.id)
  OR (SELECT COUNT(*) FROM playlist_section WHERE playlist_id = playlist.id) > 1)`;

function touch(db: Database, playlistId: string): void {
  db.prepare(`UPDATE playlist SET updated_at = ${NOW} WHERE id = ?`).run(playlistId);
}

/**
 * Up to `limit` distinct release covers for a playlist, in sketch order.
 * Distinct by thumb URL so a single-album playlist shows one image, not four.
 */
function mosaicFor(db: Database, playlistId: string, limit = 4): string[] {
  const rows = db
    .prepare(
      `SELECT r.thumb_url AS thumbUrl, MIN(s.position * 100000 + pt.position) AS pos
         FROM playlist_track pt
         JOIN playlist_section s ON s.id = pt.section_id
         JOIN track t ON t.id = pt.track_id
         JOIN release r ON r.id = t.release_id
        WHERE pt.playlist_id = ? AND r.thumb_url IS NOT NULL
        GROUP BY r.thumb_url
        ORDER BY pos
        LIMIT ?`,
    )
    .all(playlistId, limit) as { thumbUrl: string }[];
  return rows.map((r) => r.thumbUrl);
}

export function listPlaylists(db: Database): PlaylistSummary[] {
  const rows = db
    .prepare(
      `SELECT playlist.id, playlist.name, playlist.cover_url AS coverUrl,
              playlist.target_minutes AS targetMinutes,
              ${IS_GIG} AS isGig,
              (SELECT COUNT(*) FROM playlist_track
                WHERE playlist_id = playlist.id AND track_id IS NOT NULL) AS trackCount
         FROM playlist
         ORDER BY playlist.name COLLATE NOCASE`,
    )
    .all() as (Omit<PlaylistSummary, 'mosaic' | 'isGig'> & { isGig: number })[];
  return rows.map((r) => ({ ...r, isGig: !!r.isGig, mosaic: mosaicFor(db, r.id) }));
}

export function createPlaylist(db: Database, name: string, targetMinutes: number | null = null): PlaylistSummary {
  const clean = name.trim();
  if (!clean) throw new Error('playlist name required');
  const id = ulid();
  db.transaction(() => {
    db.prepare(`INSERT INTO playlist (id, name, target_minutes) VALUES (?, ?, ?)`).run(id, clean, targetMinutes);
    db.prepare(
      `INSERT INTO playlist_section (id, playlist_id, name, position, is_unsorted) VALUES (?, ?, 'Unsorted', 0, 1)`,
    ).run(ulid(), id);
  })();
  return { id, name: clean, trackCount: 0, coverUrl: null, mosaic: [], isGig: targetMinutes != null, targetMinutes };
}

export function setPlaylistCover(db: Database, id: string, coverUrl: string): void {
  db.prepare(`UPDATE playlist SET cover_url = ?, updated_at = ${NOW} WHERE id = ?`).run(coverUrl, id);
}

export function clearPlaylistCover(db: Database, id: string): void {
  db.prepare(`UPDATE playlist SET cover_url = NULL, updated_at = ${NOW} WHERE id = ?`).run(id);
}

export function renamePlaylist(db: Database, id: string, name: string): void {
  const clean = name.trim();
  if (!clean) throw new Error('playlist name required');
  db.prepare(`UPDATE playlist SET name = ?, updated_at = ${NOW} WHERE id = ?`).run(clean, id);
}

export function setTargetMinutes(db: Database, id: string, minutes: number | null): void {
  db.prepare(`UPDATE playlist SET target_minutes = ?, updated_at = ${NOW} WHERE id = ?`).run(minutes, id);
}

export function deletePlaylist(db: Database, id: string): void {
  // Sections, entries and crate rows cascade (FK ON DELETE CASCADE; the
  // foreign_keys pragma is ON for the app connection — see db/pragmas.ts).
  db.prepare(`DELETE FROM playlist WHERE id = ?`).run(id);
}

export function unsortedSectionId(db: Database, playlistId: string): string {
  const row = db
    .prepare(`SELECT id FROM playlist_section WHERE playlist_id = ? AND is_unsorted = 1`)
    .get(playlistId) as { id: string } | undefined;
  if (!row) throw new Error(`playlist has no Unsorted section: ${playlistId}`);
  return row.id;
}

export function sectionOf(
  db: Database,
  playlistId: string,
  sectionId: string,
): { id: string; name: string; isUnsorted: boolean } | null {
  const row = db
    .prepare(`SELECT id, name, is_unsorted AS isUnsorted FROM playlist_section WHERE id = ? AND playlist_id = ?`)
    .get(sectionId, playlistId) as { id: string; name: string; isUnsorted: number } | undefined;
  return row ? { id: row.id, name: row.name, isUnsorted: !!row.isUnsorted } : null;
}

export function getPlaylist(db: Database, id: string): PlaylistDetail | null {
  const playlist = db
    .prepare(
      `SELECT id, name, cover_url AS coverUrl, target_minutes AS targetMinutes, ${IS_GIG} AS isGig
         FROM playlist WHERE id = ?`,
    )
    .get(id) as { id: string; name: string; coverUrl: string | null; targetMinutes: number | null; isGig: number } | undefined;
  if (!playlist) return null;

  const sectionRows = db
    .prepare(
      `SELECT id, name, is_unsorted AS isUnsorted FROM playlist_section
        WHERE playlist_id = ? ORDER BY position, id`,
    )
    .all(id) as { id: string; name: string; isUnsorted: number }[];

  const entryRows = db
    .prepare(
      `SELECT pt.id AS entryId, pt.section_id AS sectionId, pt.track_id AS trackId,
              pt.snap_artist AS artist, pt.snap_title AS title, pt.snap_album AS album,
              pt.snap_position AS position
         FROM playlist_track pt
         JOIN playlist_section s ON s.id = pt.section_id
        WHERE pt.playlist_id = ?
        ORDER BY s.position, s.id, pt.position, pt.id`,
    )
    .all(id) as ({ entryId: string; sectionId: string; trackId: string | null } & TrackSnapshot)[];

  const byId = getTracksByIds(
    db,
    entryRows.flatMap((r) => (r.trackId ? [r.trackId] : [])),
  );

  const sections: PlaylistSection[] = sectionRows.map((s) => ({
    id: s.id,
    name: s.name,
    isUnsorted: !!s.isUnsorted,
    entries: [],
  }));
  const sectionById = new Map(sections.map((s) => [s.id, s]));
  const tracks: PlaylistTrack[] = [];
  for (const r of entryRows) {
    const track = (r.trackId ? byId.get(r.trackId) : undefined) ?? null;
    if (track) tracks.push(track);
    sectionById.get(r.sectionId)?.entries.push({
      entryId: r.entryId,
      sectionId: r.sectionId,
      track,
      snapshot: { artist: r.artist, title: r.title, album: r.album, position: r.position },
    });
  }

  const crate = db
    .prepare(
      `SELECT pr.id AS entryId, pr.release_id AS releaseId,
              COALESCE(a.name, pr.snap_artist) AS artist,
              COALESCE(r.title, pr.snap_title) AS title,
              COALESCE(r.year, pr.snap_year) AS year,
              r.thumb_url AS thumbUrl,
              (SELECT COUNT(*) FROM playlist_track pt JOIN track t ON t.id = pt.track_id
                WHERE pt.playlist_id = pr.playlist_id AND t.release_id = pr.release_id) AS sketchedCount
         FROM playlist_release pr
         LEFT JOIN release r ON r.id = pr.release_id
         LEFT JOIN artist a ON a.id = r.artist_id
        WHERE pr.playlist_id = ?
        ORDER BY pr.position, pr.id`,
    )
    .all(id) as CrateEntry[];

  return {
    id: playlist.id,
    name: playlist.name,
    coverUrl: playlist.coverUrl,
    mosaic: mosaicFor(db, id),
    targetMinutes: playlist.targetMinutes,
    isGig: !!playlist.isGig,
    tracks,
    sections,
    crate,
  };
}

function snapshotTrack(db: Database, trackId: string): (TrackSnapshot & { releaseId: string | null }) | null {
  return (
    (db
      .prepare(
        `SELECT a.name AS artist, t.title, t.album, t.position, t.release_id AS releaseId
           FROM track t JOIN artist a ON a.id = t.artist_id WHERE t.id = ?`,
      )
      .get(trackId) as (TrackSnapshot & { releaseId: string | null }) | undefined) ?? null
  );
}

function nextPosition(db: Database, table: 'playlist_track' | 'playlist_release' | 'playlist_section', col: string, value: string): number {
  const row = db
    .prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS n FROM ${table} WHERE ${col} = ?`)
    .get(value) as { n: number };
  return row.n;
}

/** Rewrite a section's positions to a contiguous 0..n by current order. */
function renumberSection(db: Database, sectionId: string): void {
  const rows = db
    .prepare(`SELECT id FROM playlist_track WHERE section_id = ? ORDER BY position, id`)
    .all(sectionId) as { id: string }[];
  const stmt = db.prepare(`UPDATE playlist_track SET position = ? WHERE id = ?`);
  rows.forEach((r, i) => stmt.run(i, r.id));
}

function addReleaseInner(db: Database, playlistId: string, releaseId: string): { added: boolean; entryId: string } {
  const existing = db
    .prepare(`SELECT id FROM playlist_release WHERE playlist_id = ? AND release_id = ?`)
    .get(playlistId, releaseId) as { id: string } | undefined;
  if (existing) return { added: false, entryId: existing.id };
  const snap = db
    .prepare(
      `SELECT a.name AS artist, r.title, r.year FROM release r JOIN artist a ON a.id = r.artist_id WHERE r.id = ?`,
    )
    .get(releaseId) as { artist: string; title: string; year: number | null } | undefined;
  if (!snap) throw new Error(`release not found: ${releaseId}`);
  const entryId = ulid();
  db.prepare(
    `INSERT INTO playlist_release (id, playlist_id, release_id, position, snap_artist, snap_title, snap_year)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(entryId, playlistId, releaseId, nextPosition(db, 'playlist_release', 'playlist_id', playlistId), snap.artist, snap.title, snap.year);
  return { added: true, entryId };
}

/**
 * Sketch a track. Lands in Unsorted unless a section is named. Its release is
 * crated if it isn't already — you can't play a track whose record stayed home.
 * A track already in the playlist is a no-op that reports where it sits.
 */
export function addTrack(
  db: Database,
  playlistId: string,
  trackId: string,
  sectionId?: string,
): { added: boolean; entryId: string; sectionName: string } {
  return db.transaction(() => {
    const existing = db
      .prepare(
        `SELECT pt.id, s.name FROM playlist_track pt JOIN playlist_section s ON s.id = pt.section_id
          WHERE pt.playlist_id = ? AND pt.track_id = ?`,
      )
      .get(playlistId, trackId) as { id: string; name: string } | undefined;
    if (existing) return { added: false, entryId: existing.id, sectionName: existing.name };

    const target = sectionId ? sectionOf(db, playlistId, sectionId) : sectionOf(db, playlistId, unsortedSectionId(db, playlistId));
    if (!target) throw new Error(`section not in playlist: ${sectionId}`);
    const snap = snapshotTrack(db, trackId);
    if (!snap) throw new Error(`track not found: ${trackId}`);

    const entryId = ulid();
    db.prepare(
      `INSERT INTO playlist_track (id, playlist_id, section_id, track_id, position, snap_artist, snap_title, snap_album, snap_position)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(entryId, playlistId, target.id, trackId, nextPosition(db, 'playlist_track', 'section_id', target.id), snap.artist, snap.title, snap.album, snap.position);
    if (snap.releaseId) addReleaseInner(db, playlistId, snap.releaseId);
    touch(db, playlistId);
    return { added: true, entryId, sectionName: target.name };
  })();
}

export function removeEntry(db: Database, playlistId: string, entryId: string): void {
  db.transaction(() => {
    const row = db
      .prepare(`SELECT section_id FROM playlist_track WHERE id = ? AND playlist_id = ?`)
      .get(entryId, playlistId) as { section_id: string } | undefined;
    if (!row) return;
    db.prepare(`DELETE FROM playlist_track WHERE id = ?`).run(entryId);
    renumberSection(db, row.section_id);
    touch(db, playlistId);
  })();
}

export function removeTrack(db: Database, playlistId: string, trackId: string): void {
  const row = db
    .prepare(`SELECT id FROM playlist_track WHERE playlist_id = ? AND track_id = ?`)
    .get(playlistId, trackId) as { id: string } | undefined;
  if (row) removeEntry(db, playlistId, row.id);
}

/**
 * The plain playlist view's reorder: a flat list of track ids, which for a
 * plain playlist is exactly its Unsorted section. Ids not named keep their
 * relative order after the named ones.
 */
export function reorderTracks(db: Database, playlistId: string, orderedTrackIds: string[]): void {
  db.transaction(() => {
    const sectionId = unsortedSectionId(db, playlistId);
    const stmt = db.prepare(
      `UPDATE playlist_track SET position = ? WHERE section_id = ? AND track_id = ?`,
    );
    const offset = orderedTrackIds.length;
    // Push everything past the named ids first, so unnamed rows sort after them.
    db.prepare(`UPDATE playlist_track SET position = position + ? WHERE section_id = ?`).run(offset, sectionId);
    orderedTrackIds.forEach((trackId, i) => stmt.run(i, sectionId, trackId));
    renumberSection(db, sectionId);
    touch(db, playlistId);
  })();
}

/** Move an entry to `index` within `sectionId` (same or different section). */
export function moveEntry(db: Database, playlistId: string, entryId: string, sectionId: string, index: number): void {
  db.transaction(() => {
    const entry = db
      .prepare(`SELECT section_id FROM playlist_track WHERE id = ? AND playlist_id = ?`)
      .get(entryId, playlistId) as { section_id: string } | undefined;
    if (!entry) throw new Error(`entry not in playlist: ${entryId}`);
    if (!sectionOf(db, playlistId, sectionId)) throw new Error(`section not in playlist: ${sectionId}`);

    const ids = (
      db
        .prepare(`SELECT id FROM playlist_track WHERE section_id = ? AND id != ? ORDER BY position, id`)
        .all(sectionId, entryId) as { id: string }[]
    ).map((r) => r.id);
    ids.splice(Math.max(0, Math.min(index, ids.length)), 0, entryId);
    const stmt = db.prepare(`UPDATE playlist_track SET section_id = ?, position = ? WHERE id = ?`);
    ids.forEach((id, i) => stmt.run(sectionId, i, id));
    if (entry.section_id !== sectionId) renumberSection(db, entry.section_id);
    touch(db, playlistId);
  })();
}

export function createSection(db: Database, playlistId: string, name: string): { id: string; name: string } {
  const clean = name.trim();
  if (!clean) throw new Error('section name required');
  const id = ulid();
  db.prepare(
    `INSERT INTO playlist_section (id, playlist_id, name, position, is_unsorted) VALUES (?, ?, ?, ?, 0)`,
  ).run(id, playlistId, clean, nextPosition(db, 'playlist_section', 'playlist_id', playlistId));
  touch(db, playlistId);
  return { id, name: clean };
}

export function renameSection(db: Database, playlistId: string, sectionId: string, name: string): void {
  const clean = name.trim();
  if (!clean) throw new Error('section name required');
  db.prepare(`UPDATE playlist_section SET name = ? WHERE id = ? AND playlist_id = ?`).run(clean, sectionId, playlistId);
  touch(db, playlistId);
}

/** Delete a section. Its tracks move to the end of Unsorted — never removed. */
export function deleteSection(db: Database, playlistId: string, sectionId: string): void {
  db.transaction(() => {
    const section = sectionOf(db, playlistId, sectionId);
    if (!section) throw new Error(`section not in playlist: ${sectionId}`);
    if (section.isUnsorted) throw new Error('Unsorted cannot be deleted');
    const unsorted = unsortedSectionId(db, playlistId);
    const base = nextPosition(db, 'playlist_track', 'section_id', unsorted);
    const moving = db
      .prepare(`SELECT id FROM playlist_track WHERE section_id = ? ORDER BY position, id`)
      .all(sectionId) as { id: string }[];
    const stmt = db.prepare(`UPDATE playlist_track SET section_id = ?, position = ? WHERE id = ?`);
    moving.forEach((r, i) => stmt.run(unsorted, base + i, r.id));
    db.prepare(`DELETE FROM playlist_section WHERE id = ?`).run(sectionId);
    reorderSectionsInner(db, playlistId, []);
    touch(db, playlistId);
  })();
}

function reorderSectionsInner(db: Database, playlistId: string, orderedSectionIds: string[]): void {
  const current = db
    .prepare(`SELECT id, is_unsorted AS isUnsorted FROM playlist_section WHERE playlist_id = ? ORDER BY position, id`)
    .all(playlistId) as { id: string; isUnsorted: number }[];
  const named = orderedSectionIds.filter((id) => current.some((c) => c.id === id && !c.isUnsorted));
  const rest = current.filter((c) => !c.isUnsorted && !named.includes(c.id)).map((c) => c.id);
  const stmt = db.prepare(`UPDATE playlist_section SET position = ? WHERE id = ?`);
  // Unsorted is pinned at 0; everything else follows from 1.
  for (const c of current) if (c.isUnsorted) stmt.run(0, c.id);
  [...named, ...rest].forEach((id, i) => stmt.run(i + 1, id));
}

export function reorderSections(db: Database, playlistId: string, orderedSectionIds: string[]): void {
  db.transaction(() => {
    reorderSectionsInner(db, playlistId, orderedSectionIds);
    touch(db, playlistId);
  })();
}

export function addRelease(db: Database, playlistId: string, releaseId: string): { added: boolean; entryId: string } {
  return db.transaction(() => {
    const r = addReleaseInner(db, playlistId, releaseId);
    if (r.added) touch(db, playlistId);
    return r;
  })();
}

/**
 * Take a record out of the bag. Its sketched tracks go with it — the caller
 * confirms first when there are any (the count is on the CrateEntry).
 */
export function removeCrateEntry(db: Database, playlistId: string, entryId: string): { removedTracks: number } {
  return db.transaction(() => {
    const row = db
      .prepare(`SELECT release_id FROM playlist_release WHERE id = ? AND playlist_id = ?`)
      .get(entryId, playlistId) as { release_id: string | null } | undefined;
    if (!row) return { removedTracks: 0 };
    let removedTracks = 0;
    if (row.release_id) {
      const affected = db
        .prepare(
          `SELECT DISTINCT pt.section_id FROM playlist_track pt JOIN track t ON t.id = pt.track_id
            WHERE pt.playlist_id = ? AND t.release_id = ?`,
        )
        .all(playlistId, row.release_id) as { section_id: string }[];
      removedTracks = db
        .prepare(
          `DELETE FROM playlist_track WHERE playlist_id = ?
              AND track_id IN (SELECT id FROM track WHERE release_id = ?)`,
        )
        .run(playlistId, row.release_id).changes;
      for (const a of affected) renumberSection(db, a.section_id);
    }
    db.prepare(`DELETE FROM playlist_release WHERE id = ?`).run(entryId);
    touch(db, playlistId);
    return { removedTracks };
  })();
}

/** Body parsing for targetMinutes: undefined = not supplied, null = clear. */
export function parseTarget(raw: unknown): number | null | undefined | 'invalid' {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0 && raw <= 24 * 60) return raw;
  return 'invalid';
}
