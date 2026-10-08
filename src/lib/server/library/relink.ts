import type { Database } from 'bun:sqlite';
import { stripEditionTags } from './normalize';

export interface RelinkSummary {
  tracks: number;
  releases: number;
}

/**
 * Name key for matching: case-, accent- and punctuation-insensitive, but it
 * keeps letters and digits in every script. The sync's a-z0-9 squash would
 * drop the Japanese and keep only the Latin, so "夜 (Instrumental)" and
 * "朝 (Instrumental)" would both become "instrumental" and a missing one would
 * re-link onto the other — a different song silently in the set.
 */
export function matchKey(s: string | null): string {
  return (s ?? '')
    .normalize('NFKD')
    .replace(/\p{Diacritic}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Re-attach sketch entries and crate rows whose track/release disappeared, by
 * the names snapshotted when they were added. Runs after every sync: a moved
 * or renamed file is deleted and re-created as a new row within one sync, so by
 * the time this runs the replacement exists.
 *
 * Conservative on purpose: only a single unambiguous candidate re-links, and
 * never onto a track the playlist already holds. A wrong re-link silently puts
 * a different song in a set; a missing row is visible and fixable by hand.
 */
export function relinkMissing(db: Database): RelinkSummary {
  const out: RelinkSummary = { tracks: 0, releases: 0 };

  const missingTracks = db
    .prepare(`SELECT id, playlist_id, snap_artist, snap_title, snap_album FROM playlist_track WHERE track_id IS NULL`)
    .all() as { id: string; playlist_id: string; snap_artist: string; snap_title: string; snap_album: string | null }[];
  if (missingTracks.length) {
    const index = new Map<string, string[]>();
    const all = db
      .prepare(`SELECT t.id, a.name AS artist, t.title, t.album FROM track t JOIN artist a ON a.id = t.artist_id`)
      .all() as { id: string; artist: string; title: string; album: string | null }[];
    for (const t of all) {
      const key = `${matchKey(t.artist)}|${matchKey(t.title)}|${matchKey(stripEditionTags(t.album ?? ''))}`;
      index.set(key, [...(index.get(key) ?? []), t.id]);
    }
    const taken = db.prepare(`SELECT 1 FROM playlist_track WHERE playlist_id = ? AND track_id = ?`);
    const set = db.prepare(`UPDATE playlist_track SET track_id = ? WHERE id = ?`);
    for (const m of missingTracks) {
      const hits = index.get(`${matchKey(m.snap_artist)}|${matchKey(m.snap_title)}|${matchKey(stripEditionTags(m.snap_album ?? ''))}`);
      if (hits?.length !== 1) continue;
      if (taken.get(m.playlist_id, hits[0])) continue;
      set.run(hits[0], m.id);
      out.tracks++;
    }
  }

  const missingReleases = db
    .prepare(`SELECT id, playlist_id, snap_artist, snap_title FROM playlist_release WHERE release_id IS NULL`)
    .all() as { id: string; playlist_id: string; snap_artist: string; snap_title: string }[];
  if (missingReleases.length) {
    const index = new Map<string, string[]>();
    const all = db
      .prepare(`SELECT r.id, a.name AS artist, r.title FROM release r JOIN artist a ON a.id = r.artist_id`)
      .all() as { id: string; artist: string; title: string }[];
    for (const r of all) {
      const key = `${matchKey(r.artist)}|${matchKey(stripEditionTags(r.title))}`;
      index.set(key, [...(index.get(key) ?? []), r.id]);
    }
    const taken = db.prepare(`SELECT 1 FROM playlist_release WHERE playlist_id = ? AND release_id = ?`);
    const set = db.prepare(`UPDATE playlist_release SET release_id = ? WHERE id = ?`);
    for (const m of missingReleases) {
      const hits = index.get(`${matchKey(m.snap_artist)}|${matchKey(stripEditionTags(m.snap_title))}`);
      if (hits?.length !== 1) continue;
      if (taken.get(m.playlist_id, hits[0])) continue;
      set.run(hits[0], m.id);
      out.releases++;
    }
  }
  return out;
}
