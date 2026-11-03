/**
 * Local tracks built from the file list. The load-bearing claims:
 *  - the first sync after the switch keeps every existing track's id, star
 *    and playlist rows (they are matched by file path and their link rewritten);
 *  - a second sync changes nothing;
 *  - a file Music.app moved keeps its track, even when a Discogs track holds
 *    the same release position;
 *  - one file reached twice is one track.
 * Temp dirs and an in-memory database only.
 *
 * Run: bun verify scripts/verify-local-result.ts
 */
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ulid } from 'ulid';
import { runMigrations } from '../src/lib/server/db/migrate';
import { collate, upsertMatchKey, upsertSourceLink } from '../src/lib/server/library/collate';
import type { FileListDeps } from '../src/lib/server/library/fileList';
import type { FileTags } from '../src/lib/server/library/tags';
import { buildLocalResult, type Catalog } from '../src/lib/server/sources/local/localResult';
import { addTrack, createPlaylist } from '../src/lib/server/library/playlists';
import { releaseIdForTags } from '../src/lib/server/sources/local/sync';
import type { SyncResult } from '../src/lib/server/sources/types';

function fail(msg: string): never { console.error(`FAIL: ${msg}`); process.exit(1); }
function assert(cond: unknown, msg: string): asserts cond { if (!cond) fail(msg); }

const root = mkdtempSync(join(tmpdir(), 'booth-localresult-'));
const p = (name: string) => join(root, name);
function write(name: string, audio: string, title: string) {
  mkdirSync(dirname(p(name)), { recursive: true });
  writeFileSync(p(name), `${audio}\n${title}\n`);
}
const deps: FileListDeps = {
  async fingerprint(path) { return createHash('md5').update(readFileSync(path, 'utf8').split('\n')[0]).digest('hex'); },
  async readTags(path): Promise<FileTags> {
    const [, title] = readFileSync(path, 'utf8').split('\n');
    return { title, artist: 'Tagged Artist', album: 'Tagged Album', year: 2020, trackNumber: 1, booth: {} };
  },
};

const db = new Database(':memory:');
db.exec('PRAGMA foreign_keys = ON');
runMigrations(db);

/** Music.app's view: two tracks of one album. */
const RELEASE = 'itunes-album:abc';
function catalog(paths: { pid: string; path: string; pos: number; title: string }[]): Catalog {
  return {
    id: 'music',
    releases: [{ externalId: RELEASE, title: 'Album', artist: 'Artist', year: 2021 }],
    tracks: paths.map((t) => ({
      catalogId: t.pid,
      path: t.path,
      track: { title: t.title, artist: 'Artist', album: 'Album', position: String(t.pos), releaseExternalId: RELEASE, facets: { playCount: 3 } },
    })),
  };
}

write('Album/01.mp3', 'AUDIO-1', 'One (tag)');
write('Album/02.mp3', 'AUDIO-2', 'Two (tag)');
const listing = [
  { pid: 'PID1', path: p('Album/01.mp3'), pos: 1, title: 'One' },
  { pid: 'PID2', path: p('Album/02.mp3'), pos: 2, title: 'Two' },
];

// --- the library as it is before the switch: Persistent-ID links ----------
const old: SyncResult = {
  releases: catalog(listing).releases,
  tracks: listing.map((t) => ({
    externalId: t.pid, title: t.title, artist: 'Artist', album: 'Album', position: String(t.pos),
    filePath: t.path, releaseExternalId: RELEASE, facets: { playCount: 3 },
  })),
};
collate(db, 'local', old);
const trackIds = () => (db.prepare(`SELECT id, title FROM track ORDER BY title`).all() as { id: string; title: string }[]);
const before = trackIds();
const oneId = before.find((t) => t.title === 'One')!.id;
db.prepare(`UPDATE track SET starred_at = '2026-10-01T00:00:00Z' WHERE id = ?`).run(oneId);
const pl1 = createPlaylist(db, 'Set', 120).id;
addTrack(db, pl1, oneId);

// --- first sync after the switch -----------------------------------
const r1 = await buildLocalResult(db, { catalogs: [catalog(listing)], boothFiles: [], groupIdFor: releaseIdForTags }, deps);
assert(r1.tracks.every((t) => t.durableId && t.externalId !== t.filePath), 'tracks carry file ids, marked durable');
assert(r1.tracks.find((t) => t.filePath === p('Album/01.mp3'))!.title === 'One', 'names come from the catalog, not the tags');
const s1 = collate(db, 'local', r1);
const after = trackIds();
assert(JSON.stringify(after) === JSON.stringify(before), `same track ids and titles: ${JSON.stringify(after)}`);
assert(s1.relinked === 2 && s1.tracksDeleted === 0 && s1.conflicts === 0, `links rewritten in place: ${JSON.stringify(s1)}`);
const star = db.prepare(`SELECT starred_at FROM track WHERE id = ?`).get(oneId) as { starred_at: string };
assert(star.starred_at === '2026-10-01T00:00:00Z', 'star kept');
const pl = db.prepare(`SELECT track_id FROM playlist_track WHERE playlist_id = ?`).get(pl1) as { track_id: string };
assert(pl.track_id === oneId, 'playlist row kept');

// --- a second sync changes nothing ---------------------------------
const s2 = collate(db, 'local', await buildLocalResult(db, { catalogs: [catalog(listing)], boothFiles: [], groupIdFor: releaseIdForTags }, deps));
assert(s2.relinked === 0 && s2.tracksDeleted === 0 && s2.conflicts === 0 && s2.releasesDeleted === 0, `second sync is quiet: ${JSON.stringify(s2)}`);
assert(JSON.stringify(trackIds()) === JSON.stringify(before), 'still the same tracks');

// --- Music.app renames the folder; a Discogs track holds position 1 ----
const releaseId = (db.prepare(`SELECT entity_id FROM source_link WHERE source='local' AND entity_kind='release'`).get() as { entity_id: string }).entity_id;
const artistId = (db.prepare(`SELECT artist_id FROM release WHERE id = ?`).get(releaseId) as { artist_id: string }).artist_id;
const discogsTrack = ulid();
db.prepare(`INSERT INTO track (id, title, artist_id, release_id, position) VALUES (?, 'One', ?, ?, '1')`).run(discogsTrack, artistId, releaseId);
upsertSourceLink(db, 'track', discogsTrack, 'discogs', '999-t1', undefined, 'release_position',
  { rowsIn: 0, releasesUpserted: 0, tracksUpserted: 0, releasesDeleted: 0, tracksDeleted: 0, conflicts: 0, relinked: 0 });
// Steal the position key, as a Discogs hydration after a repair can leave it.
upsertMatchKey(db, 'track', discogsTrack, 'release_position', `${releaseId}:1`);

mkdirSync(p('Album (Deluxe)'), { recursive: true });
renameSync(p('Album/01.mp3'), p('Album (Deluxe)/01.mp3'));
const moved = [{ ...listing[0], path: p('Album (Deluxe)/01.mp3') }, listing[1]];
const r3 = await buildLocalResult(db, { catalogs: [catalog(moved)], boothFiles: [], groupIdFor: releaseIdForTags }, deps);
const s3 = collate(db, 'local', r3);
assert(s3.tracksDeleted === 0 && s3.conflicts === 0, `move is quiet: ${JSON.stringify(s3)}`);
const path1 = db.prepare(`SELECT key_value FROM match_key WHERE entity_kind='track' AND entity_id=? AND key_type='file_path'`).get(oneId) as { key_value: string };
assert(path1.key_value === p('Album (Deluxe)/01.mp3'), `the moved track's file path follows: ${path1.key_value}`);
assert((db.prepare(`SELECT track_id FROM playlist_track WHERE playlist_id = ?`).get(pl1) as { track_id: string }).track_id === oneId, 'playlist row still on the same track');
assert(db.prepare(`SELECT 1 FROM track WHERE id = ?`).get(discogsTrack), 'the Discogs track is untouched');

// --- one file reached twice is one track ---------------------------
const twice = catalog([...moved, { pid: 'PID1-dup', path: p('Album (Deluxe)/01.mp3'), pos: 1, title: 'One' }]);
const r4 = await buildLocalResult(db, { catalogs: [twice], boothFiles: [p('Album (Deluxe)/01.mp3')], groupIdFor: releaseIdForTags }, deps);
assert(r4.tracks.filter((t) => t.filePath === p('Album (Deluxe)/01.mp3')).length === 1, 'one track for one file');
const s4 = collate(db, 'local', r4);
assert(s4.conflicts === 0 && s4.relinked === 0 && s4.tracksDeleted === 0, `no churn: ${JSON.stringify(s4)}`);

// --- an unreadable file listed by the catalog still has its track ----
write('Album/03.mp3', 'CORRUPT', '');
const brokenDeps: FileListDeps = {
  async fingerprint(path) { if (readFileSync(path, 'utf8').startsWith('CORRUPT')) throw new Error('bad'); return deps.fingerprint(path); },
  async readTags(path) { if (readFileSync(path, 'utf8').startsWith('CORRUPT')) throw new Error('bad'); return deps.readTags(path); },
};
const withBroken = catalog([...moved, { pid: 'PID3', path: p('Album/03.mp3'), pos: 3, title: 'Three' }]);
const r5 = await buildLocalResult(db, { catalogs: [withBroken], boothFiles: [], groupIdFor: releaseIdForTags }, brokenDeps);
assert(r5.tracks.some((t) => t.title === 'Three'), 'an unreadable file still gets its catalog track');
assert(r5.files.unreadable.some((u) => u.path === p('Album/03.mp3')), 'and is reported');

// --- Booth's folder: files no catalog lists become tracks from their tags --
write('booth/Artist/Album/01 Dropped.mp3', 'AUDIO-DROP', 'Dropped');
const r6 = await buildLocalResult(db, { catalogs: [withBroken], boothFiles: [p('booth/Artist/Album/01 Dropped.mp3')], groupIdFor: releaseIdForTags }, deps);
const dropped = r6.tracks.find((t) => t.filePath === p('booth/Artist/Album/01 Dropped.mp3'))!;
assert(dropped && dropped.title === 'Dropped' && (dropped.facets as Record<string, unknown>).origin === 'download', `a dropped file becomes a track: ${JSON.stringify(dropped)}`);
assert(r6.boothTracked === 1, 'counted as tracked in the folder');

// --- a file name with an encoded percent keeps its track ------------
// Review finding: Music.app's location was decoded in sync and again in
// collate, so "100%2B.mp3" (stored as 100%252B) became "100+.mp3" and the
// track lost its file-path match.
{
  write('Pct/Remix 100%2B.mp3', 'AUDIO-PCT', 'Pct');
  const path = p('Pct/Remix 100%2B.mp3');
  const url = Bun.pathToFileURL(path).href;
  collate(db, 'local', {
    releases: [{ externalId: 'itunes-album:pct', title: 'Pct', artist: 'Artist', year: 2021 }],
    tracks: [{ externalId: 'PIDPCT', title: 'Pct', artist: 'Artist', album: 'Pct', position: '1', filePath: url, releaseExternalId: 'itunes-album:pct' }],
  });
  const pctId = (db.prepare(`SELECT entity_id FROM source_link WHERE source='local' AND external_id='PIDPCT'`).get() as { entity_id: string }).entity_id;
  const pctCatalog: Catalog = {
    id: 'pct',
    releases: [{ externalId: 'itunes-album:pct', title: 'Pct', artist: 'Artist', year: 2021 }],
    tracks: [{ catalogId: 'PIDPCT', path, track: { title: 'Pct', artist: 'Artist', album: 'Pct', position: '1', releaseExternalId: 'itunes-album:pct' } }],
  };
  const sp = collate(db, 'local', await buildLocalResult(db, { catalogs: [pctCatalog], boothFiles: [], groupIdFor: releaseIdForTags }, deps));
  const key = db.prepare(`SELECT key_value FROM match_key WHERE entity_kind='track' AND entity_id=? AND key_type='file_path'`).get(pctId) as { key_value: string } | null;
  assert(key?.key_value === path, `file path stays literal: ${key?.key_value} (summary ${JSON.stringify(sp)})`);
}

rmSync(root, { recursive: true, force: true });
console.log('PASS: local result');
