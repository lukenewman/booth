/**
 * Rebuild playlists from ~/.booth/backups/playlists.log.
 *
 *   bun scripts/restore-playlists.ts [--as-of <iso>] [--log <path>] [--apply]
 *
 * Additive, like restore-annotations: it re-creates playlists, sections, sketch
 * entries and crate rows the journal knows about and the database lacks. It
 * never deletes anything. Dry run unless --apply. Tracks/releases are found by
 * id first, then by the journalled names; with no match the entry is restored
 * as a missing row, which the next sync's relink can re-attach.
 */
import { Database } from 'bun:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readPlaylistEvents, replayPlaylistEvents } from '../src/lib/server/backup/playlistJournal';
import { matchKey as k } from '../src/lib/server/library/relink';

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const apply = args.includes('--apply');
const asOf = flag('--as-of');
const log = flag('--log') ?? join(process.env.BOOTH_BACKUP_PATH ?? join(homedir(), '.booth', 'backups'), 'playlists.log');
const db = new Database(process.env.BOOTH_DB_PATH ?? join(homedir(), '.booth', 'booth.db'));
db.exec('PRAGMA foreign_keys = ON');

const exists = (table: string, id: string) => !!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id);

function findTrack(id: string | null, artist: string, title: string, album: string | null): string | null {
  if (id && exists('track', id)) return id;
  const hits = (db.prepare(`SELECT t.id, a.name AS artist, t.title, t.album FROM track t JOIN artist a ON a.id = t.artist_id WHERE t.title = ? COLLATE NOCASE`).all(title) as any[])
    .filter((r) => k(r.artist) === k(artist) && k(r.album) === k(album));
  return hits.length === 1 ? hits[0].id : null;
}
function findRelease(id: string | null, artist: string, title: string): string | null {
  if (id && exists('release', id)) return id;
  const hits = (db.prepare(`SELECT r.id, a.name AS artist FROM release r JOIN artist a ON a.id = r.artist_id WHERE r.title = ? COLLATE NOCASE`).all(title) as any[])
    .filter((r) => k(r.artist) === k(artist));
  return hits.length === 1 ? hits[0].id : null;
}

const state = replayPlaylistEvents(readPlaylistEvents(log), asOf);
const plan: string[] = [];
const tx = db.transaction(() => {
  for (const p of state.values()) {
    if (!exists('playlist', p.id)) {
      plan.push(`create playlist "${p.name}"`);
      db.prepare(`INSERT INTO playlist (id, name, target_minutes) VALUES (?, ?, ?)`).run(p.id, p.name, p.targetMinutes);
    }
    p.sections.forEach((s, si) => {
      if (exists('playlist_section', s.id)) return;
      if (s.isUnsorted && db.prepare(`SELECT 1 FROM playlist_section WHERE playlist_id = ? AND is_unsorted = 1`).get(p.id)) return;
      plan.push(`  "${p.name}": section "${s.name}"`);
      db.prepare(`INSERT INTO playlist_section (id, playlist_id, name, position, is_unsorted) VALUES (?, ?, ?, ?, ?)`)
        .run(s.id, p.id, s.name, si, s.isUnsorted ? 1 : 0);
    });
    const unsorted = (db.prepare(`SELECT id FROM playlist_section WHERE playlist_id = ? AND is_unsorted = 1`).get(p.id) as { id: string }).id;
    for (const s of p.sections) {
      const sectionId = s.isUnsorted ? unsorted : s.id;
      s.entryIds.forEach((entryId, i) => {
        if (exists('playlist_track', entryId)) return;
        const e = p.entries[entryId];
        const trackId = findTrack(e.trackId, e.artist, e.title, e.album);
        if (trackId && db.prepare(`SELECT 1 FROM playlist_track WHERE playlist_id = ? AND track_id = ?`).get(p.id, trackId)) return;
        plan.push(`  "${p.name}": ${s.name} ← ${e.artist} — ${e.title}${trackId ? '' : ' (missing)'}`);
        db.prepare(`INSERT INTO playlist_track (id, playlist_id, section_id, track_id, position, snap_artist, snap_title, snap_album, snap_position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(entryId, p.id, sectionId, trackId, 1000 + i, e.artist, e.title, e.album, e.position);
      });
    }
    p.crate.forEach((c, i) => {
      if (exists('playlist_release', c.entryId)) return;
      const releaseId = findRelease(c.releaseId, c.artist, c.title);
      if (releaseId && db.prepare(`SELECT 1 FROM playlist_release WHERE playlist_id = ? AND release_id = ?`).get(p.id, releaseId)) return;
      plan.push(`  "${p.name}": crate ← ${c.artist} — ${c.title}${releaseId ? '' : ' (missing)'}`);
      db.prepare(`INSERT INTO playlist_release (id, playlist_id, release_id, position, snap_artist, snap_title, snap_year) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(c.entryId, p.id, releaseId, 1000 + i, c.artist, c.title, c.year);
    });
  }
  if (!apply) throw new Error('dry-run');
});
try { tx(); } catch (e) { if ((e as Error).message !== 'dry-run') throw e; }
console.log(plan.length ? plan.join('\n') : 'nothing to restore');
console.log(apply ? `applied ${plan.length} change(s)` : `dry run — ${plan.length} change(s); pass --apply to write`);
