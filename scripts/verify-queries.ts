import { Database } from 'bun:sqlite';
import { runMigrations } from '../src/lib/server/db/migrate';
import { collate } from '../src/lib/server/library/collate';
import {
  listReleases,
  listTracks,
  getReleaseDetail,
  getTrackDetail,
  listSourcesWithState,
} from '../src/lib/server/library/queries';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) fail(msg);
}

const db = new Database(':memory:');
runMigrations(db);

// Seed: one release in two sources, two tracks under it from itunes.
collate(db, 'discogs', {
  releases: [
    {
      externalId: '12721',
      title: 'Homework',
      artist: 'Daft Punk',
      year: 1997,
      label: 'Virgin',
      catno: 'VIR1',
      externalUrl: 'https://www.discogs.com/release/12721',
    },
  ],
  tracks: [],
});

collate(db, 'itunes', {
  releases: [
    {
      externalId: 'itunes-album:abc',
      title: 'Homework',
      artist: 'Daft Punk',
      year: 1997,
      facets: { trackCount: 2 },
    },
    {
      externalId: 'itunes-album:def',
      title: 'Discovery',
      artist: 'Daft Punk',
      year: 2001,
    },
  ],
  tracks: [
    {
      externalId: 'itunes-1',
      title: 'Around the World',
      artist: 'Daft Punk',
      album: 'Homework',
      releaseExternalId: 'itunes-album:abc',
      filePath: '/Music/AroundTheWorld.m4a',
      facets: { rating: 5, playCount: 47 },
    },
    {
      externalId: 'itunes-2',
      title: 'Da Funk',
      artist: 'Daft Punk',
      album: 'Homework',
      releaseExternalId: 'itunes-album:abc',
      filePath: '/Music/DaFunk.m4a',
    },
  ],
});

// listReleases: no filter
const all = listReleases(db, { limit: 10, offset: 0 });
assert(all.total === 2, `expected 2 releases, got ${all.total}`);
assert(all.items.length === 2, `expected 2 items, got ${all.items.length}`);
assert(all.hasMore === false, 'hasMore should be false');

// listReleases: filter by source
const justDiscogs = listReleases(db, { source: 'discogs', limit: 10, offset: 0 });
assert(justDiscogs.total === 1, `discogs filter: expected 1, got ${justDiscogs.total}`);

// listReleases: multi_source — Homework is in both
const multi = listReleases(db, { multiSource: true, limit: 10, offset: 0 });
assert(multi.total === 1, `multi-source: expected 1, got ${multi.total}`);
assert(multi.items[0].title === 'Homework', `multi-source title wrong: ${multi.items[0].title}`);
assert(
  multi.items[0].sources.length === 2,
  `multi-source: expected 2 sources, got ${multi.items[0].sources.length}`,
);

// listReleases: search
const byQ = listReleases(db, { q: 'discov', limit: 10, offset: 0 });
assert(byQ.total === 1, `search: expected 1, got ${byQ.total}`);
assert(byQ.items[0].title === 'Discovery', `search title wrong: ${byQ.items[0].title}`);

// listReleases: pagination
const page1 = listReleases(db, { limit: 1, offset: 0 });
assert(page1.items.length === 1, `page1 size wrong: ${page1.items.length}`);
assert(page1.hasMore === true, 'page1 hasMore should be true');
const page2 = listReleases(db, { limit: 1, offset: 1 });
assert(page2.hasMore === false, 'page2 hasMore should be false');

// listTracks
const tracks = listTracks(db, { limit: 10, offset: 0 });
assert(tracks.total === 2, `tracks total: expected 2, got ${tracks.total}`);
const trackByQ = listTracks(db, { q: 'around', limit: 10, offset: 0 });
assert(trackByQ.total === 1, `track search: expected 1, got ${trackByQ.total}`);

// getReleaseDetail
const homeworkId = multi.items[0].id;
const detail = getReleaseDetail(db, homeworkId);
assert(detail !== null, 'getReleaseDetail returned null');
assert(detail!.sources.length === 2, `detail sources: expected 2, got ${detail!.sources.length}`);
assert(detail!.tracks.length === 2, `detail tracks: expected 2, got ${detail!.tracks.length}`);
assert(getReleaseDetail(db, 'no-such-id') === null, 'missing detail should be null');

// getTrackDetail
const trackId = tracks.items[0].id;
const trackDetail = getTrackDetail(db, trackId);
assert(trackDetail !== null, 'getTrackDetail returned null');
assert(trackDetail!.release !== null, 'track parent release should be present');

// listSourcesWithState
const registryStub = [
  { id: 'discogs', name: 'Discogs', contributes: ['release' as const] },
  { id: 'itunes', name: 'Apple Music', contributes: ['track' as const, 'release' as const] },
  { id: 'rekordbox', name: 'Rekordbox', contributes: ['track' as const], isStub: true },
];
const sources = listSourcesWithState(db, registryStub);
assert(sources.length === 3, `sources length: expected 3, got ${sources.length}`);
const discogs = sources.find((s) => s.id === 'discogs');
assert(discogs?.count === 1, `discogs count: expected 1, got ${discogs?.count}`);
assert(discogs?.lastSyncedAt !== null, 'discogs lastSyncedAt should be set');
const rb = sources.find((s) => s.id === 'rekordbox');
assert(rb?.isStub === true, 'rekordbox should be marked stub');
assert(rb?.count === 0, 'rekordbox count should be 0');

console.log('PASS: queries — listReleases, listTracks, details, sources-with-state');
