/**
 * A hand-set release title: renaming a local album to its Discogs title merges
 * the two copies on the spot, and later syncs from both sources keep them as
 * one release under the hand-set title.
 */
import { Database } from 'bun:sqlite';
import { ulid } from 'ulid';
import { runMigrations } from '../src/lib/server/db/migrate';
import { collate, upsertSourceLink, upsertMatchKey } from '../src/lib/server/library/collate';
import { setReleaseTitle, TitleMergeBlocked } from '../src/lib/server/library/releaseTitle';
import { createPlaylist, addTrack, addRelease, getPlaylist } from '../src/lib/server/library/playlists';
import type { SyncResult } from '../src/lib/server/sources/types';

function fail(msg: string): never { console.error(`FAIL: ${msg}`); process.exit(1); }
function assert(cond: unknown, msg: string): asserts cond { if (!cond) fail(msg); }

const db = new Database(':memory:');
db.exec('PRAGMA foreign_keys = ON');
runMigrations(db);

const discogsSync: SyncResult = {
  releases: [{ externalId: '999', title: 'Resort', artist: 'Skee Mask', year: 2024, catno: 'ITLP19', externalUrl: 'https://www.discogs.com/release/999', facets: { format: 'Vinyl' } }],
  tracks: [],
};
const localSync = (extra: string[] = []): SyncResult => ({
  releases: [{ externalId: 'album-1', title: 'ITLP19 - Resort', artist: 'Skee Mask', year: 2024 }],
  tracks: ['Hedwig', 'Nostaglitch', ...extra].map((title, i) => ({
    externalId: `pid-${i + 1}`, title, artist: 'Skee Mask', album: 'ITLP19 - Resort', position: String(i + 1),
    releaseExternalId: 'album-1', filePath: `/music/skee/${i + 1}.flac`,
  })),
});

collate(db, 'discogs', discogsSync);
collate(db, 'local', localSync());
const releaseIds = () => (db.prepare(`SELECT id, title FROM release ORDER BY title`).all() as { id: string; title: string }[]);
assert(releaseIds().length === 2, 'the two copies start apart');
const idOf = (title: string) => releaseIds().find((r) => r.title === title)!.id;
const localId = idOf('ITLP19 - Resort');
const discogsId = idOf('Resort');

// Discogs tracklist rows, as hydration would write them: one per position,
// including a third track the files don't have.
const artistId = (db.prepare(`SELECT artist_id FROM release WHERE id = ?`).get(discogsId) as { artist_id: string }).artist_id;
const discogsTrack = (pos: number, title: string) => {
  const id = ulid();
  db.prepare(`INSERT INTO track (id, title, artist_id, album, release_id, position) VALUES (?, ?, ?, 'Resort', ?, ?)`)
    .run(id, title, artistId, discogsId, String(pos));
  upsertSourceLink(db, 'track', id, 'discogs', `999-t${pos}`, null as unknown as string, 'release_position',
    { rowsIn: 0, releasesUpserted: 0, tracksUpserted: 0, releasesDeleted: 0, tracksDeleted: 0, conflicts: 0, relinked: 0 });
  upsertMatchKey(db, 'track', id, 'release_position', `${discogsId}:${pos}`);
  db.prepare(`INSERT INTO source_facets (entity_kind, entity_id, source, key, value) VALUES ('track', ?, 'discogs', 'discogsPosition', ?)`)
    .run(id, JSON.stringify(`A${pos}`));
  return id;
};
const d1 = discogsTrack(1, 'Hedwig');
const d2 = discogsTrack(2, 'Nostaglitch');
const d3 = discogsTrack(3, 'Vitamin 313');

// User data built against the Discogs copy: a star, a note, a playlist entry,
// a gig crate row, the vetted flag.
db.prepare(`UPDATE track SET starred_at = '2026-10-01T00:00:00Z' WHERE id = ?`).run(d2);
db.prepare(`UPDATE track SET note = 'long blend' WHERE id = ?`).run(d1);
db.prepare(`UPDATE release SET vetted_at = '2026-10-02T00:00:00Z' WHERE id = ?`).run(discogsId);
const gig = createPlaylist(db, 'Gig', 120);
addRelease(db, gig.id, discogsId);
addTrack(db, gig.id, d1);

// --- refused: a title another local album already has
collate(db, 'local', {
  releases: [...localSync().releases, { externalId: 'album-2', title: 'Pool', artist: 'Skee Mask', year: 2024 }],
  tracks: localSync().tracks,
});
try {
  setReleaseTitle(db, localId, 'Pool');
  fail('two local albums must not merge');
} catch (e) {
  assert(e instanceof TitleMergeBlocked, `expected a blocked merge, got ${e}`);
}
assert(releaseIds().some((r) => r.title === 'ITLP19 - Resort'), 'a refused rename changes nothing');

// --- the rename merges the copies onto the file-backed one
const res = setReleaseTitle(db, localId, 'Resort');
assert(res.releaseId === localId && res.mergedId === discogsId, `merged onto the local copy: ${JSON.stringify(res)}`);
assert(!db.prepare(`SELECT 1 FROM release WHERE id = ?`).get(discogsId), 'Discogs copy is gone');
const kept = db.prepare(`SELECT title, title_override, vetted_at, catno FROM release WHERE id = ?`).get(localId) as Record<string, string | null>;
assert(kept.title === 'Resort' && kept.title_override === 'Resort', `title set: ${JSON.stringify(kept)}`);
assert(kept.vetted_at === '2026-10-02T00:00:00Z' && kept.catno === 'ITLP19', `release data carried: ${JSON.stringify(kept)}`);
const links = (db.prepare(`SELECT source FROM source_link WHERE entity_kind='release' AND entity_id = ? ORDER BY source`).all(localId) as { source: string }[]).map((l) => l.source).join();
assert(links === 'discogs,local', `both links on one release: ${links}`);

const tracks = db.prepare(
  `SELECT t.id, t.title, t.position, t.starred_at, t.note,
          (SELECT group_concat(source) FROM (SELECT source FROM source_link WHERE entity_kind='track' AND entity_id=t.id ORDER BY source)) AS src
     FROM track t WHERE t.release_id = ? ORDER BY CAST(t.position AS INTEGER)`,
).all(localId) as { id: string; title: string; position: string; starred_at: string | null; note: string | null; src: string }[];
assert(tracks.map((t) => `${t.position}:${t.src}`).join(' ') === '1:discogs,local 2:discogs,local 3:discogs',
  `tracks paired by position: ${tracks.map((t) => `${t.position}:${t.src}`).join(' ')}`);
assert(!db.prepare(`SELECT 1 FROM track WHERE id IN (?, ?)`).get(d1, d2), 'paired Discogs rows are gone');
assert(tracks[1].starred_at === '2026-10-01T00:00:00Z', 'star moved to the local track');
assert(tracks[0].note === 'long blend', 'note moved to the local track');
assert(tracks[2].id === d3, 'unpaired Discogs track moved across as it is');
const g = getPlaylist(db, gig.id)!;
assert(g.crate.length === 1 && g.crate[0].releaseId === localId, 'crate row follows the record');
assert(g.tracks.length === 1 && g.tracks[0].id === tracks[0].id, 'playlist entry follows the track');

// --- later syncs from both sources keep it whole, under the hand-set title
collate(db, 'local', { ...localSync(), releases: [...localSync().releases, { externalId: 'album-2', title: 'Pool', artist: 'Skee Mask', year: 2024 }] });
collate(db, 'discogs', discogsSync);
const after = releaseIds().filter((r) => r.title !== 'Pool');
assert(after.length === 1 && after[0].id === localId && after[0].title === 'Resort', `still one Resort after syncs: ${JSON.stringify(after)}`);
const trackCount = (db.prepare(`SELECT COUNT(*) AS n FROM track WHERE release_id = ?`).get(localId) as { n: number }).n;
assert(trackCount === 3, `no duplicate tracks after sync: ${trackCount}`);

// --- a rename with nothing to merge just renames, and sticks through sync
const pool = idOf('Pool');
const plain = setReleaseTitle(db, pool, 'Pool (Tape)');
assert(plain.releaseId === pool && plain.mergedId === null, 'plain rename');
collate(db, 'local', { ...localSync(), releases: [...localSync().releases, { externalId: 'album-2', title: 'Pool', artist: 'Skee Mask', year: 2024 }] });
assert((db.prepare(`SELECT title FROM release WHERE id = ?`).get(pool) as { title: string }).title === 'Pool (Tape)', 'hand-set title survives a sync');

// --- clearing hands the title back to the source on the next sync
setReleaseTitle(db, pool, null);
collate(db, 'local', { ...localSync(), releases: [...localSync().releases, { externalId: 'album-2', title: 'Pool', artist: 'Skee Mask', year: 2024 }] });
assert((db.prepare(`SELECT title FROM release WHERE id = ?`).get(pool) as { title: string }).title === 'Pool', 'cleared title returns to the source');

console.log('PASS: release title — rename, merge, sync');
