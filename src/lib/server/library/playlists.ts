import type { Database } from 'bun:sqlite';
import { ulid } from 'ulid';
import { getTracksByIds, listFilteredTrackIds, type TrackRow } from './queries';
import { isEmptyRule, ruleToFilter, validateRule, type SmartRule } from '$lib/smartRule';

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
  /** Set for a smart playlist: tracks are evaluated from it on open. */
  rule: SmartRule | null;
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
  /** The crate search offers vinyl only. */
  vinylOnly: boolean;
  isGig: boolean;
  rule: SmartRule | null;
  /** Present tracks, flattened in section order — what playback queues. */
  tracks: PlaylistTrack[];
  sections: PlaylistSection[];
  crate: CrateEntry[];
}

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

/**
 * Thrown by every membership/sketch/crate mutation on a smart playlist. A smart
 * playlist's tracks come from its rule, so there is nothing to add, move or
 * remove — and refusing these is what guarantees one can never become a gig.
 */
export class SmartPlaylistError extends Error {
  constructor() {
    super('smart playlists are read-only');
    this.name = 'SmartPlaylistError';
  }
}

function parseRule(raw: string | null): SmartRule | null {
  if (raw == null) return null;
  try { return validateRule(JSON.parse(raw)) ?? {}; } catch { return {}; }
}

export function isSmart(db: Database, playlistId: string): boolean {
  const row = db.prepare(`SELECT rule FROM playlist WHERE id = ?`).get(playlistId) as { rule: string | null } | undefined;
  return row?.rule != null;
}

function assertNotSmart(db: Database, playlistId: string): void {
  if (isSmart(db, playlistId)) throw new SmartPlaylistError();
}

/** A smart playlist's tracks, newest added first. An empty rule matches nothing. */
function smartTrackIds(db: Database, rule: SmartRule): string[] {
  if (isEmptyRule(rule)) return [];
  return listFilteredTrackIds(db, { genre: ruleToFilter(rule), starred: rule.starred || undefined, sort: 'added-desc' });
}

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
              playlist.rule AS rule,
              ${IS_GIG} AS isGig,
              (SELECT COUNT(*) FROM playlist_track
                WHERE playlist_id = playlist.id AND track_id IS NOT NULL) AS trackCount
         FROM playlist
         ORDER BY playlist.name COLLATE NOCASE`,
    )
    .all() as (Omit<PlaylistSummary, 'mosaic' | 'isGig' | 'rule'> & { isGig: number; rule: string | null })[];
  return rows.map((r) => {
    const rule = parseRule(r.rule);
    if (!rule) return { ...r, rule, isGig: !!r.isGig, mosaic: mosaicFor(db, r.id) };
    const ids = smartTrackIds(db, rule);
    return { ...r, rule, isGig: false, trackCount: ids.length, mosaic: smartMosaic(db, ids) };
  });
}

/** Up to four distinct covers from the first tracks a smart playlist shows. */
function smartMosaic(db: Database, ids: string[]): string[] {
  const out: string[] = [];
  const first = ids.slice(0, 60);
  const byId = getTracksByIds(db, first);
  for (const id of first) {
    const thumb = byId.get(id)?.thumb_url;
    if (thumb && !out.includes(thumb)) out.push(thumb);
    if (out.length === 4) break;
  }
  return out;
}

export function createPlaylist(
  db: Database,
  name: string,
  targetMinutes: number | null = null,
  rule: SmartRule | null = null,
): PlaylistSummary {
  const clean = name.trim();
  if (!clean) throw new Error('playlist name required');
  const id = ulid();
  db.transaction(() => {
    db.prepare(`INSERT INTO playlist (id, name, target_minutes, rule) VALUES (?, ?, ?, ?)`)
      .run(id, clean, rule ? null : targetMinutes, rule ? JSON.stringify(rule) : null);
    db.prepare(
      `INSERT INTO playlist_section (id, playlist_id, name, position, is_unsorted) VALUES (?, ?, 'Unsorted', 0, 1)`,
    ).run(ulid(), id);
  })();
  if (rule) {
    const ids = smartTrackIds(db, rule);
    return { id, name: clean, trackCount: ids.length, coverUrl: null, mosaic: smartMosaic(db, ids), isGig: false, targetMinutes: null, rule };
  }
  return { id, name: clean, trackCount: 0, coverUrl: null, mosaic: [], isGig: targetMinutes != null, targetMinutes, rule: null };
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
  assertNotSmart(db, id);
  db.transaction(() => {
    db.prepare(`UPDATE playlist SET target_minutes = ?, updated_at = ${NOW} WHERE id = ?`).run(minutes, id);
    if (minutes != null) backfillCrate(db, id);
  })();
}

export function setVinylOnly(db: Database, id: string, on: boolean): void {
  assertNotSmart(db, id);
  db.prepare(`UPDATE playlist SET vinyl_only = ?, updated_at = ${NOW} WHERE id = ?`).run(on ? 1 : 0, id);
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
      `SELECT id, name, cover_url AS coverUrl, target_minutes AS targetMinutes, vinyl_only AS vinylOnly, rule, ${IS_GIG} AS isGig
         FROM playlist WHERE id = ?`,
    )
    .get(id) as { id: string; name: string; coverUrl: string | null; targetMinutes: number | null; vinylOnly: number; rule: string | null; isGig: number } | undefined;
  if (!playlist) return null;

  const rule = parseRule(playlist.rule);
  if (rule) {
    // One synthetic Unsorted section holding the evaluated tracks, so the
    // plain playlist view renders it unchanged. Entry ids are the track ids:
    // nothing ever mutates a smart entry, so it needs no stored id.
    const ids = smartTrackIds(db, rule);
    const byId = getTracksByIds(db, ids);
    const tracks = ids.flatMap((t) => (byId.has(t) ? [byId.get(t)!] : []));
    const sectionId = unsortedSectionId(db, id);
    return {
      id: playlist.id,
      name: playlist.name,
      coverUrl: playlist.coverUrl,
      mosaic: smartMosaic(db, ids),
      targetMinutes: null,
      vinylOnly: false,
      isGig: false,
      rule,
      tracks,
      sections: [{
        id: sectionId,
        name: 'Unsorted',
        isUnsorted: true,
        entries: tracks.map((t) => ({
          entryId: t.id,
          sectionId,
          track: t,
          snapshot: { artist: t.artist, title: t.title, album: t.album, position: t.position },
        })),
      }],
      crate: [],
    };
  }

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
    vinylOnly: !!playlist.vinylOnly,
    isGig: !!playlist.isGig,
    rule: null,
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

function isGigNow(db: Database, playlistId: string): boolean {
  const row = db.prepare(`SELECT ${IS_GIG} AS g FROM playlist WHERE id = ?`).get(playlistId) as { g: number } | undefined;
  return !!row?.g;
}

/**
 * Crate the record of every sketched track that isn't crated yet. Runs when a
 * playlist becomes a gig, so a plain playlist promoted by a section, a record
 * or a set length arrives with its bag already packed.
 */
function backfillCrate(db: Database, playlistId: string): void {
  const releases = db
    .prepare(
      `SELECT DISTINCT t.release_id AS id FROM playlist_track pt
         JOIN playlist_section s ON s.id = pt.section_id
         JOIN track t ON t.id = pt.track_id
        WHERE pt.playlist_id = ? AND t.release_id IS NOT NULL
        ORDER BY s.position, pt.position`,
    )
    .all(playlistId) as { id: string }[];
  for (const r of releases) addReleaseInner(db, playlistId, r.id);
}

/**
 * Sketch a track. Lands in Unsorted unless a section is named. In a gig its
 * release is crated if it isn't already — you can't play a track whose record
 * stayed home. A plain playlist crates nothing, or the first track added would
 * silently turn it into a gig.
 * A track already in the playlist is a no-op that reports where it sits.
 */
export function addTrack(
  db: Database,
  playlistId: string,
  trackId: string,
  sectionId?: string,
): { added: boolean; entryId: string; sectionName: string } {
  assertNotSmart(db, playlistId);
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
    if (snap.releaseId && isGigNow(db, playlistId)) addReleaseInner(db, playlistId, snap.releaseId);
    touch(db, playlistId);
    return { added: true, entryId, sectionName: target.name };
  })();
}

export function removeEntry(db: Database, playlistId: string, entryId: string): void {
  assertNotSmart(db, playlistId);
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
  assertNotSmart(db, playlistId);
  const row = db
    .prepare(`SELECT id FROM playlist_track WHERE playlist_id = ? AND track_id = ?`)
    .get(playlistId, trackId) as { id: string } | undefined;
  if (row) removeEntry(db, playlistId, row.id);
}

/**
 * The plain playlist view's reorder: a flat list of track ids, which for a
 * plain playlist is exactly its Unsorted section. Present tracks take the
 * slots present tracks held, in the new order (unnamed ones keep their
 * relative order after the named); missing rows stay in their own slots, so a
 * row that relinks later reappears where it was rather than at the bottom.
 */
export function reorderTracks(db: Database, playlistId: string, orderedTrackIds: string[]): void {
  assertNotSmart(db, playlistId);
  db.transaction(() => {
    const sectionId = unsortedSectionId(db, playlistId);
    const rows = db
      .prepare(`SELECT id, track_id AS trackId FROM playlist_track WHERE section_id = ? ORDER BY position, id`)
      .all(sectionId) as { id: string; trackId: string | null }[];
    const present = rows.filter((r) => r.trackId);
    const byTrack = new Map(present.map((r) => [r.trackId!, r]));
    const named = orderedTrackIds.flatMap((t) => (byTrack.has(t) ? [byTrack.get(t)!] : []));
    const queue = [...named, ...present.filter((r) => !named.includes(r))];
    const stmt = db.prepare(`UPDATE playlist_track SET position = ? WHERE id = ?`);
    rows.forEach((r, i) => stmt.run(i, r.trackId ? queue.shift()!.id : r.id));
    touch(db, playlistId);
  })();
}

/** Move an entry to `index` within `sectionId` (same or different section). */
export function moveEntry(db: Database, playlistId: string, entryId: string, sectionId: string, index: number): void {
  assertNotSmart(db, playlistId);
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
  assertNotSmart(db, playlistId);
  const clean = name.trim();
  if (!clean) throw new Error('section name required');
  const id = ulid();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO playlist_section (id, playlist_id, name, position, is_unsorted) VALUES (?, ?, ?, ?, 0)`,
    ).run(id, playlistId, clean, nextPosition(db, 'playlist_section', 'playlist_id', playlistId));
    backfillCrate(db, playlistId);
    touch(db, playlistId);
  })();
  return { id, name: clean };
}

export function renameSection(db: Database, playlistId: string, sectionId: string, name: string): void {
  assertNotSmart(db, playlistId);
  const clean = name.trim();
  if (!clean) throw new Error('section name required');
  db.prepare(`UPDATE playlist_section SET name = ? WHERE id = ? AND playlist_id = ?`).run(clean, sectionId, playlistId);
  touch(db, playlistId);
}

/** Delete a section. Its tracks move to the end of Unsorted — never removed. */
export function deleteSection(db: Database, playlistId: string, sectionId: string): void {
  assertNotSmart(db, playlistId);
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
  assertNotSmart(db, playlistId);
  db.transaction(() => {
    reorderSectionsInner(db, playlistId, orderedSectionIds);
    touch(db, playlistId);
  })();
}

export function addRelease(db: Database, playlistId: string, releaseId: string): { added: boolean; entryId: string } {
  assertNotSmart(db, playlistId);
  return db.transaction(() => {
    const r = addReleaseInner(db, playlistId, releaseId);
    backfillCrate(db, playlistId);
    if (r.added) touch(db, playlistId);
    return r;
  })();
}

/**
 * Take a record out of the bag. Its sketched tracks go with it — the caller
 * confirms first when there are any (the count is on the CrateEntry).
 */
export function removeCrateEntry(db: Database, playlistId: string, entryId: string): { removedTracks: number } {
  assertNotSmart(db, playlistId);
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

/** Replace a smart playlist's rule. Not for plain playlists — that would empty them. */
export function setPlaylistRule(db: Database, id: string, rule: SmartRule): void {
  if (!isSmart(db, id)) throw new Error(`not a smart playlist: ${id}`);
  db.prepare(`UPDATE playlist SET rule = ?, updated_at = ${NOW} WHERE id = ?`).run(JSON.stringify(rule), id);
}

/**
 * Freeze a smart playlist into a plain one holding its current tracks in its
 * current order — the way to start editing what a rule found.
 */
export function copySmartPlaylist(db: Database, id: string): PlaylistSummary {
  const source = getPlaylist(db, id);
  if (!source?.rule) throw new Error(`not a smart playlist: ${id}`);
  return db.transaction(() => {
    const created = createPlaylist(db, `${source.name} (copy)`);
    for (const t of source.tracks) addTrack(db, created.id, t.id);
    return { ...created, trackCount: source.tracks.length, mosaic: mosaicFor(db, created.id) };
  })();
}
