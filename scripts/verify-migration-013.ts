import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function fail(msg: string): never { console.error(`FAIL: ${msg}`); process.exit(1); }
function assert(cond: unknown, msg: string): asserts cond { if (!cond) fail(msg); }

const dir = join(import.meta.dir, '../src/lib/server/db/migrations');
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
assert(files.includes('013_gigs.sql'), '013_gigs.sql missing');

const db = new Database(':memory:');
db.exec('PRAGMA foreign_keys = ON');
const apply = (f: string) => db.transaction(() => db.exec(readFileSync(join(dir, f), 'utf8')))();
for (const f of files) if (f < '013') apply(f);

db.exec(`INSERT INTO artist (id, name) VALUES ('a1', 'Artist')`);
db.exec(`INSERT INTO release (id, title, artist_id, year) VALUES ('r1', 'Album', 'a1', 1999)`);
for (const [id, pos] of [['t1', 'A1'], ['t2', 'A2'], ['t3', 'B1']]) {
  db.prepare(`INSERT INTO track (id, title, artist_id, album, release_id, position) VALUES (?, ?, 'a1', 'Album', 'r1', ?)`)
    .run(id, `Title ${id}`, pos);
}
db.exec(`INSERT INTO playlist (id, name) VALUES ('p1', 'Evening'), ('p2', 'Empty')`);
// Deliberately out of id order so order preservation is real.
db.exec(`INSERT INTO playlist_track (playlist_id, track_id, position) VALUES ('p1','t3',0),('p1','t1',1),('p1','t2',2)`);

apply('013_gigs.sql');

const secs = db.prepare(`SELECT id, playlist_id, name, position, is_unsorted FROM playlist_section ORDER BY playlist_id`).all() as any[];
assert(secs.length === 2, `one Unsorted per playlist, got ${secs.length}`);
assert(secs.every((s) => s.is_unsorted === 1 && s.position === 0 && s.name === 'Unsorted'), 'Unsorted shape');
assert(secs[0].id === 'unsorted-p1', `deterministic unsorted id, got ${secs[0].id}`);

const rows = db.prepare(`SELECT id, section_id, track_id, position, snap_artist, snap_title, snap_album, snap_position FROM playlist_track WHERE playlist_id='p1' ORDER BY position`).all() as any[];
assert(rows.map((r) => r.track_id).join() === 't3,t1,t2', `order preserved, got ${rows.map((r) => r.track_id).join()}`);
assert(rows.every((r) => r.section_id === 'unsorted-p1'), 'rows in Unsorted');
assert(rows[0].id === 'p1:t3', 'deterministic entry id');
assert(rows[0].snap_artist === 'Artist' && rows[0].snap_title === 'Title t3' && rows[0].snap_album === 'Album' && rows[0].snap_position === 'B1', 'snapshot filled');

// Deleting a track now leaves a missing row instead of cascading.
db.exec(`DELETE FROM track WHERE id='t1'`);
const after = db.prepare(`SELECT track_id, snap_title FROM playlist_track WHERE id='p1:t1'`).get() as any;
assert(after && after.track_id === null && after.snap_title === 'Title t1', 'track delete → SET NULL, snapshot kept');

// Uniqueness only binds present tracks.
let dup = false;
try { db.exec(`INSERT INTO playlist_track (id, playlist_id, section_id, track_id, position) VALUES ('x','p1','unsorted-p1','t2',9)`); } catch { dup = true; }
assert(dup, 'duplicate present track must be rejected');
db.exec(`INSERT INTO playlist_track (id, playlist_id, section_id, track_id, position) VALUES ('y','p1','unsorted-p1',NULL,9)`);

// Crate: release delete → SET NULL; one Unsorted enforced.
db.exec(`INSERT INTO playlist_release (id, playlist_id, release_id, position, snap_artist, snap_title, snap_year) VALUES ('c1','p1','r1',0,'Artist','Album',1999)`);
db.exec(`UPDATE track SET release_id = NULL`);
db.exec(`DELETE FROM release WHERE id='r1'`);
const crate = db.prepare(`SELECT release_id FROM playlist_release WHERE id='c1'`).get() as any;
assert(crate.release_id === null, 'release delete → SET NULL');
let twoUnsorted = false;
try { db.exec(`INSERT INTO playlist_section (id, playlist_id, name, position, is_unsorted) VALUES ('u2','p1','Unsorted',5,1)`); } catch { twoUnsorted = true; }
assert(twoUnsorted, 'second Unsorted must be rejected');

// Playlist delete cascades everything.
db.exec(`DELETE FROM playlist WHERE id='p1'`);
for (const t of ['playlist_section', 'playlist_track', 'playlist_release']) {
  const n = (db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE playlist_id='p1'`).get() as any).n;
  assert(n === 0, `${t} rows must cascade on playlist delete`);
}
console.log('PASS: migration 013');
