import { Database } from 'bun:sqlite';
import { ulid } from 'ulid';
import { runMigrations } from '../src/lib/server/db/migrate';
import {
  setTrackStar,
  setReleaseVetted,
  countStarredByRelease,
} from '../src/lib/server/library/annotations';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) fail(msg);
}

const db = new Database(':memory:');
db.exec('PRAGMA foreign_keys = ON');
runMigrations(db);

const artistId = ulid();
db.prepare(`INSERT INTO artist (id, name) VALUES (?, ?)`).run(artistId, 'Test Artist');

const relId = ulid();
db.prepare(
  `INSERT INTO release (id, title, artist_id, year) VALUES (?, ?, ?, ?)`,
).run(relId, 'Test Release', artistId, 1994);

const t1 = ulid();
const t2 = ulid();
for (const [id, title, pos] of [[t1, 'Track One', 'A1'], [t2, 'Track Two', 'A2']] as const) {
  db.prepare(
    `INSERT INTO track (id, title, artist_id, album, duration_ms, release_id, position)
       VALUES (?, ?, ?, 'Test Release', 60000, ?, ?)`,
  ).run(id, title, artistId, relId, pos);
}

// --- columns exist and default to NULL -------------------------------------
const fresh = db.prepare(`SELECT starred_at FROM track WHERE id = ?`).get(t1) as {
  starred_at: string | null;
};
assert(fresh.starred_at === null, 'new track should start unstarred');

// --- star / unstar ----------------------------------------------------------
const starred = setTrackStar(db, t1, true);
assert(typeof starred.starredAt === 'string', 'starring should return a timestamp');
assert(
  /^\d{4}-\d{2}-\d{2}T/.test(starred.starredAt!),
  `starredAt should be ISO8601, got ${starred.starredAt}`,
);

const unstarred = setTrackStar(db, t1, false);
assert(unstarred.starredAt === null, 'unstarring should return null');

// --- re-starring preserves the original timestamp ---------------------------
// "When did I first star this" must stay honest if the UI ever double-fires.
const first = setTrackStar(db, t1, true).starredAt;
const second = setTrackStar(db, t1, true).starredAt;
assert(first === second, `re-star should preserve timestamp: ${first} vs ${second}`);

// --- annotations must not bump updated_at -----------------------------------
// updated_at tracks source-data freshness, not user judgment.
const beforeUpd = (
  db.prepare(`SELECT updated_at FROM track WHERE id = ?`).get(t2) as { updated_at: string }
).updated_at;
setTrackStar(db, t2, true);
const afterUpd = (
  db.prepare(`SELECT updated_at FROM track WHERE id = ?`).get(t2) as { updated_at: string }
).updated_at;
assert(beforeUpd === afterUpd, 'starring must not bump track.updated_at');

// --- vetting ----------------------------------------------------------------
const vetted = setReleaseVetted(db, relId, true);
assert(typeof vetted.vettedAt === 'string', 'vetting should return a timestamp');
assert(setReleaseVetted(db, relId, false).vettedAt === null, 'unvetting should return null');

// A release with zero starred tracks can still be vetted — the whole point of
// storing the flag rather than deriving it.
setTrackStar(db, t1, false);
setTrackStar(db, t2, false);
setReleaseVetted(db, relId, true);
const vettedNoStars = db
  .prepare(`SELECT vetted_at FROM release WHERE id = ?`)
  .get(relId) as { vetted_at: string | null };
assert(vettedNoStars.vetted_at !== null, 'a release with no starred tracks must stay vettable');

// --- countStarredByRelease --------------------------------------------------
setTrackStar(db, t1, true);
const counts = countStarredByRelease(db, [relId]);
assert(counts.get(relId) === 1, `expected 1 starred track, got ${counts.get(relId)}`);

setTrackStar(db, t2, true);
assert(countStarredByRelease(db, [relId]).get(relId) === 2, 'expected 2 starred tracks');

assert(countStarredByRelease(db, []).size === 0, 'empty id list should return an empty map');

const unknown = countStarredByRelease(db, [ulid()]);
assert(unknown.size === 0, 'unknown release id should not appear in the map');

// --- star follows the track row on delete -----------------------------------
db.prepare(`DELETE FROM track WHERE id = ?`).run(t2);
assert(countStarredByRelease(db, [relId]).get(relId) === 1, 'deleting a track drops its star');

// --- notes ------------------------------------------------------------------
const { setTrackNote, MAX_NOTE_LENGTH } = await import(
  '../src/lib/server/library/annotations'
);

assert(setTrackNote(db, t1, 'peak time roller').note === 'peak time roller', 'note round-trips');
assert(setTrackNote(db, t1, '  padded  ').note === 'padded', 'note is trimmed');

// Empty and whitespace-only clear rather than storing '' — otherwise "has a
// note" needs two checks everywhere and a cleared note stays invisibly present.
assert(setTrackNote(db, t1, '').note === null, 'empty string clears the note');
setTrackNote(db, t1, 'again');
assert(setTrackNote(db, t1, '   ').note === null, 'whitespace-only clears the note');
assert(setTrackNote(db, t1, null).note === null, 'null clears the note');

const long = 'x'.repeat(MAX_NOTE_LENGTH + 500);
assert(
  setTrackNote(db, t1, long).note!.length === MAX_NOTE_LENGTH,
  `note is capped at ${MAX_NOTE_LENGTH}`,
);
setTrackNote(db, t1, null);

// --- query filters ----------------------------------------------------------
const { listReleases, listTracks, listTrackIds } = await import(
  '../src/lib/server/library/queries'
);

// Seed a second release so the filters have something to exclude.
const rel2 = ulid();
db.prepare(`INSERT INTO release (id, title, artist_id, year) VALUES (?, ?, ?, ?)`).run(
  rel2,
  'Second Release',
  artistId,
  2001,
);
const t3 = ulid();
db.prepare(
  `INSERT INTO track (id, title, artist_id, album, duration_ms, release_id, position)
     VALUES (?, 'Track Three', ?, 'Second Release', 60000, ?, 'A1')`,
).run(t3, artistId, rel2);

// Both releases need a playable link, or listTrackIds filters them out.
for (const [tid, path] of [[t1, '/music/one.wav'], [t3, '/music/three.wav']] as const) {
  db.prepare(
    `INSERT INTO source_link (entity_kind, entity_id, source, external_id, external_url, match_method)
       VALUES ('track', ?, 'local', ?, NULL, 'file_path')`,
  ).run(tid, path);
}

// starred filter on tracks: t1 is starred, t3 is not.
const starredTracks = listTracks(db, { starred: true, limit: 50, offset: 0 });
assert(starredTracks.total === 1, `expected 1 starred track, got ${starredTracks.total}`);
assert(starredTracks.items[0].id === t1, 'starred filter returned the wrong track');
assert(
  starredTracks.items[0].starred_at !== null,
  'starred track row should carry starred_at',
);

const allTracks = listTracks(db, { limit: 50, offset: 0 });
assert(allTracks.total === 2, `unfiltered should see 2 tracks, got ${allTracks.total}`);

// listTrackIds must agree with listTracks under the same filter — the playback
// queue depends on the two producing identical ordering and membership.
const starredIds = listTrackIds(db, { starred: true });
assert(starredIds.length === 1, `expected 1 starred id, got ${starredIds.length}`);
assert(starredIds[0] === t1, 'listTrackIds disagrees with listTracks on the starred filter');

// vetted filter on releases: relId is vetted, rel2 is not.
const unvetted = listReleases(db, { vetted: false, limit: 50, offset: 0 });
assert(unvetted.total === 1, `expected 1 unvetted release, got ${unvetted.total}`);
assert(unvetted.items[0].id === rel2, 'unvetted filter returned the wrong release');

const vettedOnly = listReleases(db, { vetted: true, limit: 50, offset: 0 });
assert(vettedOnly.total === 1, `expected 1 vetted release, got ${vettedOnly.total}`);
assert(vettedOnly.items[0].id === relId, 'vetted filter returned the wrong release');

// starredCount rides along on release rows.
const allRels = listReleases(db, { limit: 50, offset: 0 });
const byId = new Map(allRels.items.map((r) => [r.id, r]));
assert(byId.get(relId)!.starredCount === 1, 'relId should report 1 starred track');
assert(byId.get(rel2)!.starredCount === 0, 'rel2 should report 0 starred tracks');
assert(byId.get(relId)!.vetted_at !== null, 'release row should carry vetted_at');

console.log('OK: verify-stars');
