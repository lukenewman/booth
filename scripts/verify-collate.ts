import { Database } from 'bun:sqlite';
import { runMigrations } from '../src/lib/server/db/migrate';
import { collate } from '../src/lib/server/library/collate';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) fail(msg);
}

const db = new Database(':memory:');
runMigrations(db);

// --- Run 1: discogs sync, one release ---------------------------
const r1 = collate(db, 'discogs', {
  releases: [
    {
      externalId: '12721',
      title: 'Homework',
      artist: 'Daft Punk',
      year: 1997,
      country: 'France',
      label: 'Virgin',
      catno: '7243 8 42609 2 6',
      externalUrl: 'https://www.discogs.com/release/12721',
      facets: { thumb: 'https://t/h.jpg' },
    },
  ],
  tracks: [],
});
assert(r1.releasesUpserted === 1, 'r1 upserted');
const releaseRow = db.prepare('SELECT id, title FROM release').get() as any;
assert(releaseRow.title === 'Homework', 'release row exists');

// --- Run 2: itunes sync, same album, different externalId, file paths --
const r2 = collate(db, 'itunes', {
  releases: [
    {
      externalId: 'itunes-album:abc123',
      title: 'Homework',
      artist: 'Daft Punk',
      year: 1997,
      facets: { trackCount: 16 },
    },
  ],
  tracks: [
    {
      externalId: '12345',
      title: 'Around the World',
      artist: 'Daft Punk',
      album: 'Homework',
      releaseExternalId: 'itunes-album:abc123',
      filePath: 'file:///Users/luke/Music/Around%20the%20World.m4a',
      facets: { rating: 5, playCount: 47 },
    },
  ],
});
assert(r2.releasesUpserted === 1, 'r2 release upserted');
assert(r2.tracksUpserted === 1, 'r2 track upserted');

const releaseCount = db.prepare('SELECT COUNT(*) AS n FROM release').get() as any;
assert(releaseCount.n === 1, `expected 1 release after collation, got ${releaseCount.n}`);

const sourceLinks = db
  .prepare(`SELECT source, external_id, match_method FROM source_link WHERE entity_kind='release' ORDER BY source`)
  .all() as any[];
assert(sourceLinks.length === 2, `expected 2 release source_links, got ${sourceLinks.length}`);
assert(sourceLinks[0].source === 'discogs' && sourceLinks[0].match_method === 'first_seen', 'discogs link');
assert(sourceLinks[1].source === 'itunes' && sourceLinks[1].match_method === 'artist_album_year', 'itunes link via match key');

const trackRow = db.prepare('SELECT release_id, title FROM track').get() as any;
assert(trackRow.release_id === releaseRow.id, 'track linked to release');

const facets = db
  .prepare(`SELECT key, value FROM source_facets WHERE source='itunes' AND entity_kind='track'`)
  .all() as any[];
assert(facets.length === 2, 'two itunes facets');

// --- Run 3: re-run itunes, should be idempotent (no new entity rows) ----
const r3 = collate(db, 'itunes', {
  releases: [
    {
      externalId: 'itunes-album:abc123',
      title: 'Homework',
      artist: 'Daft Punk',
      year: 1997,
      facets: { trackCount: 16 },
    },
  ],
  tracks: [
    {
      externalId: '12345',
      title: 'Around the World',
      artist: 'Daft Punk',
      album: 'Homework',
      releaseExternalId: 'itunes-album:abc123',
      filePath: 'file:///Users/luke/Music/Around%20the%20World.m4a',
      facets: { rating: 5, playCount: 47 },
    },
  ],
});
const releaseCount2 = db.prepare('SELECT COUNT(*) AS n FROM release').get() as any;
const trackCount2 = db.prepare('SELECT COUNT(*) AS n FROM track').get() as any;
assert(releaseCount2.n === 1, 're-run did not duplicate releases');
assert(trackCount2.n === 1, 're-run did not duplicate tracks');
assert(r3.conflicts === 0, 're-run produced no conflicts');

// --- Run 4: itunes drops the track, should be pruned --------------------
const r4 = collate(db, 'itunes', {
  releases: [
    {
      externalId: 'itunes-album:abc123',
      title: 'Homework',
      artist: 'Daft Punk',
      year: 1997,
    },
  ],
  tracks: [],
});
assert(r4.tracksDeleted === 1, `track should be deleted, got ${r4.tracksDeleted}`);
const trackCount4 = db.prepare('SELECT COUNT(*) AS n FROM track').get() as any;
assert(trackCount4.n === 0, 'track row gone');

// --- Run 5: discogs drops its release, but itunes still references it.
//           The release should survive (still has itunes source_link).
const r5 = collate(db, 'discogs', { releases: [], tracks: [] });
const releaseCount5 = db.prepare('SELECT COUNT(*) AS n FROM release').get() as any;
assert(releaseCount5.n === 1, `release should survive while itunes still references it, got ${releaseCount5.n}`);
const linksAfter = db.prepare("SELECT source FROM source_link WHERE entity_kind='release'").all() as any[];
assert(linksAfter.length === 1 && linksAfter[0].source === 'itunes', 'only itunes link remains');

// --- Run 6: itunes contributes two Track IDs that share the same file path.
//           Both resolve to the same entity via match_key; the second insert
//           must be detected as a UQ conflict, not crash with SqliteError.
const db2 = new Database(':memory:');
runMigrations(db2);
const r6 = collate(db2, 'itunes', {
  releases: [],
  tracks: [
    {
      externalId: 'tA',
      title: 'Same Song',
      artist: 'Artist',
      filePath: 'file:///Users/x/Music/song.m4a',
    },
    {
      externalId: 'tB',
      title: 'Same Song (dupe import)',
      artist: 'Artist',
      filePath: 'file:///Users/x/Music/song.m4a',
    },
  ],
});
assert(r6.tracksUpserted === 2, `both tracks attempted upsert, got ${r6.tracksUpserted}`);
assert(r6.conflicts === 1, `expected 1 UQ conflict, got ${r6.conflicts}`);
const linkCount6 = db2.prepare("SELECT COUNT(*) AS n FROM source_link WHERE entity_kind='track' AND source='itunes'").get() as any;
assert(linkCount6.n === 1, `expected 1 itunes track source_link (the second is dropped as conflict), got ${linkCount6.n}`);

console.log('OK: collate');
