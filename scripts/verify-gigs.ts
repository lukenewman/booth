import { Database } from 'bun:sqlite';
import { ulid } from 'ulid';
import { runMigrations } from '../src/lib/server/db/migrate';
import {
  createPlaylist, getPlaylist, listPlaylists, addTrack, removeEntry, removeTrack, moveEntry,
  createSection, renameSection, deleteSection, reorderSections, addRelease, removeCrateEntry,
  setTargetMinutes, unsortedSectionId, reorderTracks,
} from '../src/lib/server/library/playlists';

function fail(msg: string): never { console.error(`FAIL: ${msg}`); process.exit(1); }
function assert(cond: unknown, msg: string): asserts cond { if (!cond) fail(msg); }

const db = new Database(':memory:');
db.exec('PRAGMA foreign_keys = ON');
runMigrations(db);

const artist = ulid();
db.prepare(`INSERT INTO artist (id, name) VALUES (?, 'Artist')`).run(artist);
function release(title: string): string {
  const id = ulid();
  db.prepare(`INSERT INTO release (id, title, artist_id, year) VALUES (?, ?, ?, 2001)`).run(id, title, artist);
  return id;
}
function track(title: string, releaseId: string | null, pos: string): string {
  const id = ulid();
  db.prepare(`INSERT INTO track (id, title, artist_id, album, release_id, position, duration_ms) VALUES (?, ?, ?, 'LP', ?, ?, 300000)`)
    .run(id, title, artist, releaseId, pos);
  return id;
}
const r1 = release('LP One');
const r2 = release('LP Two');
const a1 = track('A1 tune', r1, 'A1');
const a2 = track('A2 tune', r1, 'A2');
const b1 = track('B1 tune', r2, 'B1');
const loose = track('No release', null, '1');

// --- plain playlist: one hidden Unsorted, not a gig
const p = createPlaylist(db, 'Saturday');
let d = getPlaylist(db, p.id)!;
assert(d.sections.length === 1 && d.sections[0].isUnsorted, 'new playlist has exactly Unsorted');
assert(d.isGig === false, 'plain playlist is not a gig');

// --- addTrack defaults to Unsorted and crates the release
const r = addTrack(db, p.id, a1);
assert(r.added && r.sectionName === 'Unsorted', 'add lands in Unsorted');
d = getPlaylist(db, p.id)!;
assert(d.crate.length === 1 && d.crate[0].releaseId === r1 && d.crate[0].sketchedCount === 1, 'release auto-crated with count');
assert(d.isGig === true, 'crate makes it a gig');
addTrack(db, p.id, loose);
assert(getPlaylist(db, p.id)!.crate.length === 1, 'release-less track adds no crate row');

// --- dedupe reports where it already is
const again = addTrack(db, p.id, a1);
assert(!again.added && again.sectionName === 'Unsorted', 'dedupe names the existing section');

// --- sections: create, add into one, rename, reorder (Unsorted pinned first)
const openers = createSection(db, p.id, 'Openers');
const closers = createSection(db, p.id, 'Closers');
assert(addTrack(db, p.id, a2, openers.id).sectionName === 'Openers', 'add into named section');
addTrack(db, p.id, b1, closers.id);
renameSection(db, p.id, openers.id, 'Openers / ambient');
reorderSections(db, p.id, [closers.id, openers.id, unsortedSectionId(db, p.id)]);
d = getPlaylist(db, p.id)!;
assert(d.sections.map((s) => s.name).join('|') === 'Unsorted|Closers|Openers / ambient', `section order: ${d.sections.map((s) => s.name).join('|')}`);
assert(d.tracks.map((t) => t.title).join('|') === 'A1 tune|No release|B1 tune|A2 tune', `flat order follows sections: ${d.tracks.map((t) => t.title).join('|')}`);
assert(d.crate.length === 2, 'b1 crated r2');

// --- moveEntry across sections, to an index
const entryOf = (trackId: string) => getPlaylist(db, p.id)!.sections.flatMap((s) => s.entries).find((e) => e.track?.id === trackId)!;
moveEntry(db, p.id, entryOf(a1).entryId, closers.id, 0);
d = getPlaylist(db, p.id)!;
const cl = d.sections.find((s) => s.id === closers.id)!;
assert(cl.entries.map((e) => e.track!.title).join('|') === 'A1 tune|B1 tune', 'moved to head of Closers');

// --- deleting a section moves its tracks to the END of Unsorted, in order
deleteSection(db, p.id, closers.id);
d = getPlaylist(db, p.id)!;
assert(!d.sections.some((s) => s.id === closers.id), 'section gone');
assert(d.sections[0].entries.map((e) => e.track!.title).join('|') === 'No release|A1 tune|B1 tune', `Unsorted after delete: ${d.sections[0].entries.map((e) => e.track!.title).join('|')}`);
let threw = false;
try { deleteSection(db, p.id, unsortedSectionId(db, p.id)); } catch { threw = true; }
assert(threw, 'Unsorted cannot be deleted');

// --- a track disappearing leaves a missing entry, excluded from tracks/trackCount
db.prepare(`DELETE FROM track WHERE id = ?`).run(b1);
d = getPlaylist(db, p.id)!;
const missing = d.sections.flatMap((s) => s.entries).find((e) => e.track === null)!;
assert(missing && missing.snapshot.title === 'B1 tune' && missing.snapshot.position === 'B1', 'missing entry keeps snapshot');
assert(!d.tracks.some((t) => t.title === 'B1 tune'), 'missing excluded from flat tracks');
assert(listPlaylists(db).find((x) => x.id === p.id)!.trackCount === d.tracks.length, 'trackCount counts present only');
removeEntry(db, p.id, missing.entryId);
assert(!getPlaylist(db, p.id)!.sections.flatMap((s) => s.entries).some((e) => e.track === null), 'missing entry removable');

// --- crate: r2 stays crated after its only sketched track vanished (count 0); re-adding is a no-op
addRelease(db, p.id, r2);
d = getPlaylist(db, p.id)!;
assert(d.crate.find((c) => c.releaseId === r2)!.sketchedCount === 0, 'crated with no ideas → 0');
assert(!addRelease(db, p.id, r2).added, 'crate dedupe');
const r1Entry = d.crate.find((c) => c.releaseId === r1)!;
const { removedTracks } = removeCrateEntry(db, p.id, r1Entry.entryId);
assert(removedTracks === 2, `removing r1 takes its 2 sketched tracks, got ${removedTracks}`);
d = getPlaylist(db, p.id)!;
assert(d.tracks.map((t) => t.title).join('|') === 'No release', 'only release-less track left');

// --- missing release keeps snapshot
db.prepare(`UPDATE track SET release_id = NULL WHERE release_id = ?`).run(r2);
db.prepare(`DELETE FROM release WHERE id = ?`).run(r2);
d = getPlaylist(db, p.id)!;
assert(d.crate.length === 1 && d.crate[0].releaseId === null && d.crate[0].title === 'LP Two', 'missing crate row shows snapshot');

// --- target length alone makes a gig; flat reorder still works for plain playlists
const q = createPlaylist(db, 'Plain');
const x1 = track('X1', null, '1');
const x2 = track('X2', null, '2');
addTrack(db, q.id, x1); addTrack(db, q.id, x2);
reorderTracks(db, q.id, [x2, x1]);
assert(getPlaylist(db, q.id)!.tracks.map((t) => t.title).join() === 'X2,X1', 'flat reorder');
removeTrack(db, q.id, x2);
assert(getPlaylist(db, q.id)!.tracks.length === 1, 'removeTrack by track id');
assert(!getPlaylist(db, q.id)!.isGig, 'plain still plain');
setTargetMinutes(db, q.id, 180);
assert(getPlaylist(db, q.id)!.isGig && getPlaylist(db, q.id)!.targetMinutes === 180, 'target length → gig');

console.log('PASS: gigs — sections, sketch, crate, missing rows');
