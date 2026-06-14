import type { Database } from 'bun:sqlite';
import { ulid } from 'ulid';
import { getTracksByIds, type TrackRow } from './queries';

export interface PlaylistSummary {
  id: string;
  name: string;
  trackCount: number;
}

export type PlaylistTrack = TrackRow & { sources: string[]; canPlay: boolean };

export interface PlaylistDetail {
  id: string;
  name: string;
  tracks: PlaylistTrack[];
}

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

export function listPlaylists(db: Database): PlaylistSummary[] {
  return db
    .prepare(
      `SELECT playlist.id, playlist.name,
              (SELECT COUNT(*) FROM playlist_track WHERE playlist_id = playlist.id) AS trackCount
         FROM playlist
         ORDER BY playlist.name COLLATE NOCASE`,
    )
    .all() as PlaylistSummary[];
}

export function createPlaylist(db: Database, name: string): PlaylistSummary {
  const clean = name.trim();
  if (!clean) throw new Error('playlist name required');
  const id = ulid();
  db.prepare(`INSERT INTO playlist (id, name) VALUES (?, ?)`).run(id, clean);
  return { id, name: clean, trackCount: 0 };
}

export function renamePlaylist(db: Database, id: string, name: string): void {
  const clean = name.trim();
  if (!clean) throw new Error('playlist name required');
  db.prepare(`UPDATE playlist SET name = ?, updated_at = ${NOW} WHERE id = ?`).run(clean, id);
}

export function deletePlaylist(db: Database, id: string): void {
  // playlist_track rows cascade (FK ON DELETE CASCADE; foreign_keys pragma is
  // ON for the app connection — see db/index.ts).
  db.prepare(`DELETE FROM playlist WHERE id = ?`).run(id);
}

export function getPlaylist(db: Database, id: string): PlaylistDetail | null {
  const playlist = db
    .prepare(`SELECT id, name FROM playlist WHERE id = ?`)
    .get(id) as { id: string; name: string } | undefined;
  if (!playlist) return null;

  const orderRows = db
    .prepare(`SELECT track_id FROM playlist_track WHERE playlist_id = ? ORDER BY position`)
    .all(id) as { track_id: string }[];

  const byId = getTracksByIds(db, orderRows.map((r) => r.track_id));
  const tracks: PlaylistTrack[] = [];
  for (const { track_id } of orderRows) {
    const t = byId.get(track_id);
    if (t) tracks.push(t);
  }
  return { id: playlist.id, name: playlist.name, tracks };
}

export function addTrack(db: Database, playlistId: string, trackId: string): { added: boolean } {
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO playlist_track (playlist_id, track_id, position)
         VALUES (?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM playlist_track WHERE playlist_id = ?))`,
    )
    .run(playlistId, trackId, playlistId);
  const added = res.changes > 0;
  if (added) db.prepare(`UPDATE playlist SET updated_at = ${NOW} WHERE id = ?`).run(playlistId);
  return { added };
}

export function removeTrack(db: Database, playlistId: string, trackId: string): void {
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM playlist_track WHERE playlist_id = ? AND track_id = ?`).run(playlistId, trackId);
    renumber(db, playlistId);
    db.prepare(`UPDATE playlist SET updated_at = ${NOW} WHERE id = ?`).run(playlistId);
  });
  tx();
}

export function reorderTracks(db: Database, playlistId: string, orderedTrackIds: string[]): void {
  const tx = db.transaction(() => {
    let pos = 0;
    const stmt = db.prepare(
      `UPDATE playlist_track SET position = ? WHERE playlist_id = ? AND track_id = ?`,
    );
    for (const trackId of orderedTrackIds) {
      stmt.run(pos, playlistId, trackId);
      pos++;
    }
    // Any ids not named in orderedTrackIds keep their (now higher) positions;
    // renumber compacts everything to a clean 0..n by current position.
    renumber(db, playlistId);
    db.prepare(`UPDATE playlist SET updated_at = ${NOW} WHERE id = ?`).run(playlistId);
  });
  tx();
}

/** Rewrite a playlist's positions to a contiguous 0..n by current order. */
function renumber(db: Database, playlistId: string): void {
  const rows = db
    .prepare(`SELECT track_id FROM playlist_track WHERE playlist_id = ? ORDER BY position`)
    .all(playlistId) as { track_id: string }[];
  const stmt = db.prepare(
    `UPDATE playlist_track SET position = ? WHERE playlist_id = ? AND track_id = ?`,
  );
  rows.forEach((r, i) => stmt.run(i, playlistId, r.track_id));
}
