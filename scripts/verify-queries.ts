import { Database } from 'bun:sqlite';
import { runMigrations } from '../src/lib/server/db/migrate';
import { collate } from '../src/lib/server/library/collate';
import {
  listReleases,
  listTracks,
  listArtists,
  getReleaseDetail,
  getTrackDetail,
  getArtistDetail,
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

// listTracks: multi_source — seed a 2nd-source link for one track, then expect 1.
const aroundTheWorldId = tracks.items.find((t) => t.title === 'Around the World')!.id;
db.prepare(
  `INSERT INTO source_link (entity_kind, entity_id, source, external_id, external_url, match_method)
     VALUES ('track', ?, 'plex', 'plex-1', NULL, 'first_seen')`,
).run(aroundTheWorldId);
const multiTracks = listTracks(db, { multiSource: true, limit: 10, offset: 0 });
assert(multiTracks.total === 1, `multi-source tracks: expected 1, got ${multiTracks.total}`);
assert(
  multiTracks.items[0].title === 'Around the World',
  `multi-source track wrong: ${multiTracks.items[0].title}`,
);

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

// ---- Artists ------------------------------------------------------------

// Two distinct artists in the seed: Daft Punk (multi-source: discogs + itunes
// for Homework, itunes only for Discovery) and the implicit (unknown) sentinel
// (since the seeded data all has artists, no rows use it — it should still
// appear in listArtists with zero counts).
const allArtists = listArtists(db, { limit: 10, offset: 0 });
const daft = allArtists.items.find((a) => a.name.toLowerCase() === 'daft punk');
assert(daft, 'listArtists must surface Daft Punk');
assert(daft!.releaseCount === 2, `daft releaseCount: expected 2, got ${daft!.releaseCount}`);
assert(daft!.trackCount === 2, `daft trackCount: expected 2, got ${daft!.trackCount}`);
// Daft Punk picks up sources from any of its releases (discogs, itunes) or
// its tracks (the multi-source test above seeded a plex link on one track).
assert(
  daft!.sources.includes('discogs')
  && daft!.sources.includes('itunes')
  && daft!.sources.includes('plex'),
  `daft sources: ${JSON.stringify(daft!.sources)}`,
);

// Source filter — listing the 'discogs' source should return only artists who
// have at least one discogs-linked release (or track).
const discogsArtists = listArtists(db, { source: 'discogs', limit: 10, offset: 0 });
assert(discogsArtists.total === 1, `discogs-filtered artists: expected 1, got ${discogsArtists.total}`);
assert(discogsArtists.items[0].name.toLowerCase() === 'daft punk', 'discogs artist must be Daft Punk');

// Multi-source filter — Daft Punk has releases in both sources.
const multiArtists = listArtists(db, { multiSource: true, limit: 10, offset: 0 });
assert(multiArtists.total === 1, `multi-source artists: expected 1, got ${multiArtists.total}`);
assert(multiArtists.items[0].name.toLowerCase() === 'daft punk');

// Search.
const qArtists = listArtists(db, { q: 'daft', limit: 10, offset: 0 });
assert(qArtists.total === 1, `q=daft: expected 1, got ${qArtists.total}`);

// Detail.
const artistDetail = getArtistDetail(db, daft!.id);
assert(artistDetail !== null, 'getArtistDetail returned null');
assert(artistDetail!.artist.id === daft!.id, 'detail.artist.id mismatch');
assert(artistDetail!.releases.length === 2, `detail releases: expected 2, got ${artistDetail!.releases.length}`);
assert(artistDetail!.trackCount === 2, `detail trackCount: expected 2, got ${artistDetail!.trackCount}`);
// Each release in detail should carry its sources via JOIN.
const homeworkInDetail = artistDetail!.releases.find((r) => r.title === 'Homework');
assert(
  homeworkInDetail && homeworkInDetail.sources.length === 2,
  'detail.releases[homework].sources should include both sources',
);

assert(getArtistDetail(db, 'no-such-id') === null, 'missing artist detail should be null');

console.log('PASS: queries — listReleases, listTracks, listArtists, details, sources-with-state');
