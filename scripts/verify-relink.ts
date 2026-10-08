import { Database } from 'bun:sqlite';
import { ulid } from 'ulid';
import { runMigrations } from '../src/lib/server/db/migrate';
import { createPlaylist, addTrack, getPlaylist } from '../src/lib/server/library/playlists';
import { relinkMissing } from '../src/lib/server/library/relink';

function fail(msg: string): never { console.error(`FAIL: ${msg}`); process.exit(1); }
function assert(cond: unknown, msg: string): asserts cond { if (!cond) fail(msg); }

const db = new Database(':memory:');
db.exec('PRAGMA foreign_keys = ON');
runMigrations(db);
const artist = (name: string) => { const id = ulid(); db.prepare(`INSERT INTO artist (id, name) VALUES (?, ?)`).run(id, name); return id; };
const rel = (a: string, title: string) => { const id = ulid(); db.prepare(`INSERT INTO release (id, title, artist_id, year) VALUES (?, ?, ?, 2000)`).run(id, title, a); return id; };
const trk = (a: string, title: string, album: string, releaseId: string | null) => {
  const id = ulid();
  db.prepare(`INSERT INTO track (id, title, artist_id, album, release_id, position) VALUES (?, ?, ?, ?, ?, 'A1')`).run(id, title, a, album, releaseId);
  return id;
};
const missingTitles = (pid: string) => getPlaylist(db, pid)!.sections.flatMap((s) => s.entries).filter((e) => !e.track).map((e) => e.snapshot.title).sort();

const A = artist('Ryo Fukui');
const J = artist('細野晴臣');
const r = rel(A, 'Scenery');
const p = createPlaylist(db, 'Gig');

// 1. renamed file: track row deleted, a new row with the same names appears → re-links
const t1 = trk(A, 'Early Summer', 'Scenery', r);
addTrack(db, p.id, t1);
db.prepare(`DELETE FROM track WHERE id = ?`).run(t1);
const t1b = trk(A, 'Early  Summer', 'Scenery', r); // whitespace differs; squash ignores it

// 2. ambiguous: two candidates → stays missing
const t2 = trk(A, 'Willow Weep for Me', 'Scenery', r);
addTrack(db, p.id, t2);
db.prepare(`DELETE FROM track WHERE id = ?`).run(t2);
trk(A, 'Willow Weep for Me', 'Scenery', r);
trk(A, 'Willow Weep For Me', 'Scenery', r);

// 3. collision: the only candidate is already in the playlist → stays missing
const t3 = trk(A, 'Mellow Dream', 'Scenery', r);
addTrack(db, p.id, t3);
db.prepare(`DELETE FROM track WHERE id = ?`).run(t3);
const t3b = trk(A, 'Mellow Dream', 'Scenery', r);
addTrack(db, p.id, t3b);

// 4. non-Latin title squashes to empty → exact-text fallback still re-links
const t4 = trk(J, '恋は桃色', 'HOSONO HOUSE', null);
addTrack(db, p.id, t4);
db.prepare(`DELETE FROM track WHERE id = ?`).run(t4);
const t4b = trk(J, '恋は桃色', 'HOSONO HOUSE', null);

// 5. crate record leaves and returns
const r2 = rel(A, 'My Favorite Tune');
db.prepare(`INSERT INTO playlist_release (id, playlist_id, release_id, position, snap_artist, snap_title, snap_year) VALUES ('c2', ?, ?, 9, 'Ryo Fukui', 'My Favorite Tune', 2000)`).run(p.id, r2);
db.prepare(`DELETE FROM release WHERE id = ?`).run(r2);
const r2b = rel(A, 'My Favorite Tune (Reissue)'); // edition tag stripped for matching

assert(missingTitles(p.id).length === 4, `4 missing before relink, got ${missingTitles(p.id).join(',')}`);
const res = relinkMissing(db);
assert(res.tracks === 2 && res.releases === 1, `relinked ${JSON.stringify(res)}`);
const d = getPlaylist(db, p.id)!;
const ids = d.tracks.map((t) => t.id);
assert(ids.includes(t1b) && ids.includes(t4b), 'renamed + non-Latin re-linked');
assert(missingTitles(p.id).join('|') === 'Mellow Dream|Willow Weep for Me', `left missing: ${missingTitles(p.id).join('|')}`);
assert(d.crate.find((c) => c.entryId === 'c2')!.releaseId === r2b, 'crate re-linked');
assert(relinkMissing(db).tracks === 0, 'idempotent');
console.log('PASS: relink');
