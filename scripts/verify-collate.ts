import { Database } from 'bun:sqlite';
import { runMigrations } from '../src/lib/server/db/migrate';
import {
  collate,
  resolveReleaseEntity,
  upsertArtist,
  upsertMatchKey,
} from '../src/lib/server/library/collate';

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

// --- Run 4: itunes drops the track. An empty track list means "this sync
//           didn't fetch tracks", not "delete them all", so the prune is
//           skipped; a sync that does contribute tracks prunes the missing one.
const r4a = collate(db, 'itunes', {
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
assert(r4a.tracksDeleted === 0, `empty track list must not prune, got ${r4a.tracksDeleted}`);
const trackCount4a = db.prepare('SELECT COUNT(*) AS n FROM track').get() as any;
assert(trackCount4a.n === 1, 'track row survives a release-only sync');

const r4 = collate(db, 'itunes', {
  releases: [
    {
      externalId: 'itunes-album:abc123',
      title: 'Homework',
      artist: 'Daft Punk',
      year: 1997,
    },
  ],
  tracks: [
    {
      externalId: '67890',
      title: 'Da Funk',
      artist: 'Daft Punk',
      album: 'Homework',
      releaseExternalId: 'itunes-album:abc123',
      filePath: 'file:///Users/luke/Music/Da%20Funk.m4a',
    },
  ],
});
assert(r4.tracksDeleted === 1, `dropped track should be pruned, got ${r4.tracksDeleted}`);
const trackCount4 = db.prepare('SELECT COUNT(*) AS n FROM track').get() as any;
assert(trackCount4.n === 1, `only the surviving track remains, got ${trackCount4.n}`);

// --- Run 5: discogs drops its release, but itunes still references it.
//           The release should survive (still has itunes source_link). An empty
//           release list is again "didn't fetch", so the sync must contribute a
//           different release for the prune to run at all.
const r5empty = collate(db, 'discogs', { releases: [], tracks: [] });
assert(r5empty.releasesDeleted === 0, 'empty release list must not prune');

const r5 = collate(db, 'discogs', {
  releases: [
    { externalId: '99999', title: 'Random Access Memories', artist: 'Daft Punk', year: 2013 },
  ],
  tracks: [],
});
assert(r5.releasesDeleted === 0, `entity kept by itunes must not be deleted, got ${r5.releasesDeleted}`);
const homeworkLinks = db
  .prepare(
    `SELECT sl.source FROM source_link sl
      INNER JOIN release r ON r.id = sl.entity_id
      WHERE sl.entity_kind='release' AND r.title='Homework'`,
  )
  .all() as any[];
assert(
  homeworkLinks.length === 1 && homeworkLinks[0].source === 'itunes',
  'discogs link pruned, itunes link keeps the release alive',
);
const homeworkStillThere = db.prepare("SELECT COUNT(*) AS n FROM release WHERE title='Homework'").get() as any;
assert(homeworkStillThere.n === 1, 'Homework release survives');

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
// A file_path match is authoritative — same bytes on disk — so the second row
// relinks the entity rather than conflicting. Either way exactly one link and
// one entity survive; the relink path is what stops a later prune from
// deleting the entity behind a renumbered id.
assert(r6.relinked === 1, `expected 1 relink, got ${r6.relinked}`);
assert(r6.conflicts === 0, `authoritative match must not conflict, got ${r6.conflicts}`);
const linkCount6 = db2.prepare("SELECT COUNT(*) AS n FROM source_link WHERE entity_kind='track' AND source='itunes'").get() as any;
assert(linkCount6.n === 1, `expected 1 itunes track source_link, got ${linkCount6.n}`);
const trackCount6 = db2.prepare('SELECT COUNT(*) AS n FROM track').get() as any;
assert(trackCount6.n === 1, `duplicate import must not create a second track, got ${trackCount6.n}`);

// --- Run 7: a repress splits the year. Local tags carry the album's original
//           release year; Discogs carries the year of the pressing in the
//           collection. The weaker artist_album key must still pair them.
const db3 = new Database(':memory:');
runMigrations(db3);
collate(db3, 'local', {
  releases: [
    {
      externalId: 'itunes-album:suntub',
      title: 'Suntub',
      artist: 'ML Buch',
      year: 2023,
      facets: {},
    },
  ],
  tracks: [],
});
const r7 = collate(db3, 'discogs', {
  releases: [
    {
      externalId: '30278324',
      title: 'Suntub',
      artist: 'ML Buch',
      year: 2024,
      externalUrl: 'https://www.discogs.com/release/30278324',
      facets: {},
    },
  ],
  tracks: [],
});
assert(r7.conflicts === 0, `repress should not conflict, got ${r7.conflicts}`);
const releaseCount7 = db3.prepare('SELECT COUNT(*) AS n FROM release').get() as any;
assert(releaseCount7.n === 1, `repress must collapse to one release, got ${releaseCount7.n}`);
const links7 = db3
  .prepare("SELECT source, match_method FROM source_link WHERE entity_kind='release' ORDER BY source")
  .all() as any[];
assert(links7.length === 2, `expected 2 release links, got ${links7.length}`);
assert(
  links7.find((l) => l.source === 'discogs')?.match_method === 'artist_album',
  'discogs link should record the weaker match method',
);

// The weaker key must not merge two different albums by the same artist.
collate(db3, 'discogs', {
  releases: [
    { externalId: '999', title: 'Skinned', artist: 'ML Buch', year: 2020, facets: {} },
  ],
  tracks: [],
});
const releaseCount7b = db3.prepare('SELECT COUNT(*) AS n FROM release').get() as any;
assert(releaseCount7b.n === 2, `different album must stay separate, got ${releaseCount7b.n}`);

// --- Run 8: the shared resolver the Discogs add path uses. Adding a record
//           the library already holds locally must return the existing entity,
//           never mint a second one.
const existing = resolveReleaseEntity(db3, { artist: 'ML Buch', album: 'Suntub', year: 2024 });
assert(existing !== null, 'resolver should find the existing Suntub entity');
assert(existing!.method === 'artist_album_year', `expected exact key, got ${existing!.method}`);
const byRepressYear = resolveReleaseEntity(db3, { artist: 'ML Buch', album: 'Suntub', year: 2031 });
assert(byRepressYear?.entityId === existing!.entityId, 'unknown year must fall back to artist_album');
assert(
  resolveReleaseEntity(db3, { artist: 'Nobody', album: 'Nothing', year: 2024 }) === null,
  'unknown release resolves to null',
);

// The weaker key is claimed first-come and must not flap: two entities that
// already share artist+album (splits that predate this key) would otherwise
// trade it back and forth on every sync and the fallback would never resolve.
const db4 = new Database(':memory:');
runMigrations(db4);
const artistId = upsertArtist(db4, 'Astrid Sonne');
for (const [id, year] of [['relA', 2023], ['relB', 2024]] as const) {
  db4
    .prepare('INSERT INTO release (id, title, artist_id, year) VALUES (?, ?, ?, ?)')
    .run(id, 'Great Doubt', artistId, year);
}
upsertMatchKey(db4, 'release', 'relA', 'artist_album', 'astridsonne|greatdoubt', { steal: false });
upsertMatchKey(db4, 'release', 'relB', 'artist_album', 'astridsonne|greatdoubt', { steal: false });
const owner = db4
  .prepare(
    "SELECT entity_id FROM match_key WHERE entity_kind='release' AND key_type='artist_album'",
  )
  .get() as any;
assert(owner.entity_id === 'relA', `first claimant keeps the weak key, got ${owner.entity_id}`);

// The exact key still moves, so an artist rename between syncs re-points it.
upsertMatchKey(db4, 'release', 'relA', 'artist_album_year', 'astridsonne|greatdoubt|2024');
upsertMatchKey(db4, 'release', 'relB', 'artist_album_year', 'astridsonne|greatdoubt|2024');
const exactOwner = db4
  .prepare(
    "SELECT entity_id FROM match_key WHERE entity_kind='release' AND key_type='artist_album_year'",
  )
  .get() as any;
assert(exactOwner.entity_id === 'relB', `exact key still moves, got ${exactOwner.entity_id}`);

console.log('OK: collate');
