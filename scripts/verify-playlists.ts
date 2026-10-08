import { Database } from 'bun:sqlite';
import { ulid } from 'ulid';
import { runMigrations } from '../src/lib/server/db/migrate';
import {
  listPlaylists,
  createPlaylist,
  renamePlaylist,
  deletePlaylist,
  getPlaylist,
  addTrack,
  removeTrack,
  reorderTracks,
} from '../src/lib/server/library/playlists';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) fail(msg);
}

const db = new Database(':memory:');
db.exec('PRAGMA foreign_keys = ON'); // required for cascade assertions
runMigrations(db);

// Seed: one artist, two tracks. track1 is playable (local source_link),
// track2 is not (no playable link) — exercises canPlay passthrough.
const artistId = ulid();
db.prepare(`INSERT INTO artist (id, name) VALUES (?, ?)`).run(artistId, 'Test Artist');

const t1 = ulid();
const t2 = ulid();
db.prepare(
  `INSERT INTO track (id, title, artist_id, album, duration_ms, release_id, position)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`,
).run(t1, 'Track One', artistId, 'Album', 60000, 'A1');
db.prepare(
  `INSERT INTO track (id, title, artist_id, album, duration_ms, release_id, position)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`,
).run(t2, 'Track Two', artistId, 'Album', 90000, 'A2');
db.prepare(
  `INSERT INTO source_link (entity_kind, entity_id, source, external_id, external_url, match_method)
     VALUES ('track', ?, 'local', '/music/one.wav', NULL, 'file_path')`,
).run(t1);

// create
const p = createPlaylist(db, 'Evening');
assert(p.name === 'Evening', `created name wrong: ${p.name}`);
assert(p.trackCount === 0, `new playlist trackCount should be 0, got ${p.trackCount}`);

// listPlaylists
let list = listPlaylists(db);
assert(list.length === 1, `expected 1 playlist, got ${list.length}`);
assert(list[0].id === p.id, 'list id mismatch');

// addTrack (both), with dedupe no-op on re-add
assert(addTrack(db, p.id, t1).added === true, 't1 add should report added');
assert(addTrack(db, p.id, t2).added === true, 't2 add should report added');
assert(addTrack(db, p.id, t1).added === false, 're-adding t1 should be a no-op');

list = listPlaylists(db);
assert(list[0].trackCount === 2, `trackCount should be 2, got ${list[0].trackCount}`);

// getPlaylist: ordered, canPlay passes through
let detail = getPlaylist(db, p.id);
assert(detail !== null, 'getPlaylist returned null');
assert(detail!.tracks.length === 2, `detail tracks: expected 2, got ${detail!.tracks.length}`);
assert(detail!.tracks[0].id === t1 && detail!.tracks[1].id === t2, 'initial order wrong');
assert(detail!.tracks[0].canPlay === true, 't1 should be playable');
assert(detail!.tracks[1].canPlay === false, 't2 should not be playable');

// reorder
reorderTracks(db, p.id, [t2, t1]);
detail = getPlaylist(db, p.id);
assert(detail!.tracks[0].id === t2 && detail!.tracks[1].id === t1, 'reorder did not take');

// removeTrack renumbers (remaining single track sits at position 0)
removeTrack(db, p.id, t2);
detail = getPlaylist(db, p.id);
assert(detail!.tracks.length === 1 && detail!.tracks[0].id === t1, 'remove failed');
const pos = db.prepare(`SELECT position FROM playlist_track WHERE playlist_id=? AND track_id IS NOT NULL`).get(p.id) as { position: number };
assert(pos.position === 0, `remaining track should be renumbered to 0, got ${pos.position}`);

// rename
renamePlaylist(db, p.id, 'Late Night');
assert(listPlaylists(db)[0].name === 'Late Night', 'rename did not take');

// deleting a track leaves a missing entry (no longer a cascade)
db.prepare(`DELETE FROM track WHERE id=?`).run(t1);
detail = getPlaylist(db, p.id);
assert(detail!.tracks.length === 0, 'missing track is not in the flat list');
assert(detail!.sections[0].entries.length === 1 && detail!.sections[0].entries[0].track === null, 'missing entry kept');

// deletePlaylist cascades remaining join rows + removes the playlist.
// Re-add t2 (the track still exists — it was only removed from the playlist
// earlier; t1 is the one we hard-deleted) so there's a join row to cascade.
addTrack(db, p.id, t2);
deletePlaylist(db, p.id);
assert(listPlaylists(db).length === 0, 'playlist should be gone after delete');
const orphans = db.prepare(`SELECT COUNT(*) AS n FROM playlist_track`).get() as { n: number };
assert(orphans.n === 0, `playlist_track rows should be gone after playlist delete, got ${orphans.n}`);

console.log('PASS: playlists — create, list, add/dedupe, reorder, remove, rename, missing rows');
