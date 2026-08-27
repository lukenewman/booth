import { Database } from 'bun:sqlite';
import { runMigrations } from '../src/lib/server/db/migrate';
import { collate } from '../src/lib/server/library/collate';
import {
  BPM_KEY_ANALYZED,
  BPM_KEY_TAG,
  resolveBpm,
  resolveBpmForTracks,
} from '../src/lib/server/library/bpm';
import { bpmRange, formatBpm, formatBpmRange, pitchedBpm } from '../src/lib/bpm';
import { getTrackDetail, listTracks } from '../src/lib/server/library/queries';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) fail(msg);
}

// --- Precedence ---------------------------------------------------

const all = [
  { source: 'local', key: BPM_KEY_TAG, value: '120' },
  { source: 'local', key: BPM_KEY_ANALYZED, value: '121.5' },
  { source: 'rekordbox', key: BPM_KEY_TAG, value: '122' },
];

assert(resolveBpm(all)?.value === 122, 'rekordbox wins over everything');
assert(resolveBpm(all)?.provider === 'rekordbox', 'provider reported as rekordbox');

const noRb = all.filter((f) => f.source !== 'rekordbox');
assert(resolveBpm(noRb)?.value === 121.5, 'analysis wins over tag');
assert(resolveBpm(noRb)?.provider === 'analysis', 'provider reported as analysis');

const tagOnly = [{ source: 'local', key: BPM_KEY_TAG, value: '120' }];
assert(resolveBpm(tagOnly)?.provider === 'tag', 'tag is the fallback');

assert(resolveBpm([]) === null, 'no facets resolves to null');

// --- Junk rejection -----------------------------------------------
// Music.app stores 0 for "not set", and a 0 renders as a real reading if it
// gets through. That is the whole reason parseBpm has a floor.

assert(resolveBpm([{ source: 'local', key: BPM_KEY_TAG, value: '0' }]) === null, '0 rejected');
assert(resolveBpm([{ source: 'local', key: BPM_KEY_TAG, value: '' }]) === null, 'empty rejected');
assert(resolveBpm([{ source: 'local', key: BPM_KEY_TAG, value: 'x' }]) === null, 'junk rejected');
assert(resolveBpm([{ source: 'local', key: BPM_KEY_TAG, value: '900' }]) === null, '900 rejected');

// A rejected higher-precedence value must not mask a good lower one.
const junkOverGood = [
  { source: 'rekordbox', key: BPM_KEY_TAG, value: '0' },
  { source: 'local', key: BPM_KEY_TAG, value: '128' },
];
assert(resolveBpm(junkOverGood)?.value === 128, 'junk at high precedence falls through');

// --- Formatting ---------------------------------------------------

assert(formatBpm(120) === '120', 'integer formats bare');
assert(formatBpm(121.5) === '121.5', 'fraction keeps one decimal');
assert(formatBpm(121.47) === '121.5', 'fraction rounds to one decimal');

// --- Pitched tempo and reachable range ----------------------------
// This is what the readout exists to answer: what can I mix this with.

assert(pitchedBpm(128, 0) === 128, 'centre leaves the tempo alone');
assert(Math.abs(pitchedBpm(128, 8) - 138.24) < 1e-9, '+8% on 128 is 138.24');
assert(Math.abs(pitchedBpm(128, -8) - 117.76) < 1e-9, '-8% on 128 is 117.76');

const r8 = bpmRange(128, 8);
assert(Math.abs(r8.min - 117.76) < 1e-9, 'range floor matches full negative pitch');
assert(Math.abs(r8.max - 138.24) < 1e-9, 'range ceiling matches full positive pitch');

const r16 = bpmRange(128, 16);
assert(r16.min < r8.min && r16.max > r8.max, 'the wide range strictly contains the narrow one');

assert(formatBpmRange(128, 8) === '117.8–138.2', 'range renders to one decimal with an en dash');

// --- Through the DB and the query layer ---------------------------

const db = new Database(':memory:');
runMigrations(db);

collate(db, 'local', {
  releases: [{ externalId: 'alb-1', title: 'Homework', artist: 'Daft Punk', year: 1997 }],
  tracks: [
    {
      externalId: 'p1',
      title: 'Revolution 909',
      artist: 'Daft Punk',
      album: 'Homework',
      position: '1',
      filePath: '/tmp/booth-verify/909.mp3',
      releaseExternalId: 'alb-1',
      facets: { bpm: 122 },
    },
    {
      externalId: 'p2',
      title: 'Rollin & Scratchin',
      artist: 'Daft Punk',
      album: 'Homework',
      position: '2',
      filePath: '/tmp/booth-verify/rollin.mp3',
      releaseExternalId: 'alb-1',
      // No BPM: the common case at launch, and it must resolve to null, not 0.
      facets: {},
    },
  ],
});

const ids = db.prepare('SELECT id FROM track ORDER BY position').all() as { id: string }[];
assert(ids.length === 2, 'two tracks collated');
const [withBpm, withoutBpm] = ids;

const batch = resolveBpmForTracks(db, [withBpm.id, withoutBpm.id]);
assert(batch.get(withBpm.id)?.value === 122, 'batch resolve found the tagged track');
assert(batch.get(withBpm.id)?.provider === 'tag', 'batch resolve reports provider');
assert(!batch.has(withoutBpm.id), 'untagged track absent from the map');
assert(resolveBpmForTracks(db, []).size === 0, 'empty id list is a no-op');

const listed = listTracks(db, { limit: 50, offset: 0 });
const listedWith = listed.items.find((t) => t.id === withBpm.id);
const listedWithout = listed.items.find((t) => t.id === withoutBpm.id);
assert(listedWith?.bpm?.value === 122, 'listTracks carries bpm');
assert(listedWithout?.bpm === null, 'listTracks reports null for untagged');

const detail = getTrackDetail(db, withBpm.id);
assert(detail?.bpm?.value === 122, 'getTrackDetail carries bpm');

// A second sync that drops the tag must clear the reading rather than strand it.
collate(db, 'local', {
  releases: [{ externalId: 'alb-1', title: 'Homework', artist: 'Daft Punk', year: 1997 }],
  tracks: [
    {
      externalId: 'p1',
      title: 'Revolution 909',
      artist: 'Daft Punk',
      album: 'Homework',
      position: '1',
      filePath: '/tmp/booth-verify/909.mp3',
      releaseExternalId: 'alb-1',
      facets: { bpm: 123 },
    },
  ],
});
assert(resolveBpmForTracks(db, [withBpm.id]).get(withBpm.id)?.value === 123, 're-sync updates bpm');

// Analysis writing its own key must not disturb the tag underneath it.
db.prepare(
  `INSERT INTO source_facets (entity_kind, entity_id, source, key, value)
   VALUES ('track', ?, 'local', ?, ?)`,
).run(withBpm.id, BPM_KEY_ANALYZED, '123.8');
const afterAnalysis = resolveBpmForTracks(db, [withBpm.id]).get(withBpm.id);
assert(afterAnalysis?.value === 123.8, 'analysis outranks the tag');
assert(afterAnalysis?.provider === 'analysis', 'analysis provider reported');

console.log('OK: bpm resolution');
