/**
 * rekordbox as a catalog source. Load-bearing claims:
 *  - the collection export is read with paths decoded, entities unescaped and
 *    playlist entries ignored;
 *  - its facts attach to the Booth track whose file it names, matching paths
 *    across Unicode normalisation (Music.app writes some names decomposed,
 *    rekordbox composed);
 *  - entries without a Booth track are reported, not imported;
 *  - importing twice changes nothing, and an entry dropped from the export
 *    takes its facts with it;
 *  - the BPM shown is rekordbox's once imported.
 * Temp dirs and an in-memory database only.
 *
 * Run: bun verify scripts/verify-rekordbox-catalog.ts
 */
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runMigrations } from '../src/lib/server/db/migrate';
import { collate } from '../src/lib/server/library/collate';
import type { FileListDeps } from '../src/lib/server/library/fileList';
import { buildLocalResult } from '../src/lib/server/sources/local/localResult';
import { releaseIdForTags } from '../src/lib/server/sources/local/sync';
import { readRekordboxCollection } from '../src/lib/server/cdj/rekordbox-xml';
import { importRekordbox } from '../src/lib/server/library/rekordbox';
import { getTracksByIds } from '../src/lib/server/library/queries';

function fail(msg: string): never { console.error(`FAIL: ${msg}`); process.exit(1); }
function assert(cond: unknown, msg: string): asserts cond { if (!cond) fail(msg); }

const root = mkdtempSync(join(tmpdir(), 'booth-rekordbox-'));
const p = (n: string) => join(root, n);
const write = (n: string, audio: string) => { mkdirSync(dirname(p(n)), { recursive: true }); writeFileSync(p(n), `${audio}\nT\n`); };
const url = (path: string) => 'file://localhost' + path.split('/').map(encodeURIComponent).join('/');

// "Café" decomposed (e + combining acute), as Music.app sometimes names files.
const CAFE_NFD = 'Café';
write('A/01 One.mp3', 'AUD1');
write('A/02 Two.mp3', 'AUD2');
write(`A/03 ${CAFE_NFD}.mp3`, 'AUD3');

function exportXml(opts: { dropTwo?: boolean } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="rekordbox" Version="7.2.14" Company="AlphaTheta"/>
  <COLLECTION Entries="4">
    <TRACK TrackID="101" Name="One &amp; Only" Artist="Artist" AverageBpm="122.00" Tonality="Am"
           DateAdded="2025-08-25" PlayCount="3" Rating="0" Location="${url(p('A/01 One.mp3'))}">
      <TEMPO Inizio="0.049" Bpm="122.00" Metro="4/4" Battito="1"/>
      <POSITION_MARK Name="drop" Type="0" Start="32.100" Num="0" Red="255" Green="55" Blue="111"/>
      <POSITION_MARK Name="" Type="4" Start="64.000" End="72.000" Num="-1"/>
    </TRACK>
${opts.dropTwo ? '' : `    <TRACK TrackID="102" Name="Two" Artist="Artist" AverageBpm="0.00" Tonality=""
           Rating="255" Location="${url(p('A/02 Two.mp3'))}">
    </TRACK>`}
    <TRACK TrackID="103" Name="Café" Artist="Artist" AverageBpm="98.50" Tonality="F#m"
           Location="${url(p(`A/03 ${CAFE_NFD}.mp3`).normalize('NFC'))}">
      <TEMPO Inizio="0.100" Bpm="98.50" Metro="4/4" Battito="1"/>
      <TEMPO Inizio="60.100" Bpm="99.00" Metro="4/4" Battito="1"/>
    </TRACK>
    <TRACK TrackID="104" Name="Elsewhere" Artist="Nobody" AverageBpm="128.00"
           Location="${url(p('B/not in booth.wav'))}">
    </TRACK>
  </COLLECTION>
  <PLAYLISTS>
    <NODE Type="0" Name="ROOT" Count="1">
      <NODE Name="Set" Type="1" KeyType="0" Entries="1">
        <TRACK Key="101"/>
      </NODE>
    </NODE>
  </PLAYLISTS>
</DJ_PLAYLISTS>
`;
}
const xmlPath = p('rekordbox.xml');

// --- reader -----------------------------------------------------------------
writeFileSync(xmlPath, exportXml());
const tracks = readRekordboxCollection(xmlPath);
{
  assert(tracks.length === 4, `four collection tracks, playlist entry ignored, got ${tracks.length}`);
  const one = tracks.find((t) => t.trackId === '101')!;
  assert(one.title === 'One & Only' && one.path === p('A/01 One.mp3'), `entities and path decoded, got ${JSON.stringify(one)}`);
  assert(one.bpm === 122 && one.key === 'Am' && one.playCount === 3 && one.dateAdded === '2025-08-25', `scalars read, got ${JSON.stringify(one)}`);
  assert(one.grid.length === 1 && one.grid[0].start === 0.049 && one.grid[0].bpm === 122 && one.grid[0].meter === '4/4', `grid read, got ${JSON.stringify(one.grid)}`);
  assert(one.cues.length === 2 && one.cues[1].end === 72, `hot cue and loop read, got ${JSON.stringify(one.cues)}`);
  const two = tracks.find((t) => t.trackId === '102')!;
  assert(two.bpm === null && two.key === null && two.grid.length === 0 && two.rating === 255, `blank values are null, got ${JSON.stringify(two)}`);
  const cafe = tracks.find((t) => t.trackId === '103')!;
  assert(cafe.grid.length === 2, 'variable tempo keeps every grid section');
  console.log('ok reader');
}

// --- import -------------------------------------------------------------------
const deps: FileListDeps = {
  async fingerprint(path) { return createHash('md5').update(readFileSync(path, 'utf8').split('\n')[0]).digest('hex'); },
  async readTags() { return { title: 'T', artist: 'Artist', album: 'Album', year: 2020, trackNumber: 1, booth: {} }; },
};
const db = new Database(':memory:');
db.exec('PRAGMA foreign_keys = ON');
runMigrations(db);
const listed = [
  { pid: 'P1', name: 'A/01 One.mp3', pos: 1, title: 'One' },
  { pid: 'P2', name: 'A/02 Two.mp3', pos: 2, title: 'Two' },
  { pid: 'P3', name: `A/03 ${CAFE_NFD}.mp3`, pos: 3, title: 'Café' },
];
const built = await buildLocalResult(db, {
  catalogs: [{
    id: 'music',
    releases: [{ externalId: 'rel', title: 'Album', artist: 'Artist', year: 2021 }],
    tracks: listed.map((t) => ({ catalogId: t.pid, path: p(t.name), track: { title: t.title, artist: 'Artist', album: 'Album', position: String(t.pos), releaseExternalId: 'rel', facets: {} } })),
  }],
  boothFiles: [],
  groupIdFor: releaseIdForTags,
}, deps);
collate(db, 'local', { tracks: built.tracks, releases: built.releases });
const trackOf = (n: string) => (db.prepare(
  `SELECT sl.entity_id AS id FROM source_link sl JOIN audio_file f ON f.id = sl.external_id
    WHERE sl.source = 'local' AND sl.entity_kind = 'track' AND f.path = ?`,
).get(p(n)) as { id: string }).id;
const facetRows = () => db.prepare(`SELECT entity_id, key, value FROM source_facets WHERE source = 'rekordbox' ORDER BY entity_id, key`).all();
const facetsOf = (id: string) => Object.fromEntries((db.prepare(`SELECT key, value FROM source_facets WHERE source = 'rekordbox' AND entity_id = ?`).all(id) as { key: string; value: string }[]).map((r) => [r.key, JSON.parse(r.value)]));
{
  const s = importRekordbox(db, xmlPath, tracks);
  assert(s.entries === 4 && s.matched === 3 && s.unmatchedCount === 1, `three matched, one not, got ${JSON.stringify(s)}`);
  assert(s.unmatched[0].title === 'Elsewhere' && s.unmatched[0].path === p('B/not in booth.wav'), 'the unmatched entry is named');
  assert(s.withGrid === 2 && s.withCues === 1, `grid and cue counts, got ${JSON.stringify(s)}`);
  const one = facetsOf(trackOf('A/01 One.mp3'));
  assert(one.bpm === 122 && one.key === 'Am' && one.grid.length === 1 && one.cues.length === 2 && one.playCount === 3, `facts attached, got ${JSON.stringify(one)}`);
  const cafe = facetsOf(trackOf(`A/03 ${CAFE_NFD}.mp3`));
  assert(cafe.key === 'F#m', 'a composed rekordbox path matches a decomposed Booth path');
  const two = facetsOf(trackOf('A/02 Two.mp3'));
  assert(two.bpm === undefined && two.key === undefined && two.rating === 255, `blank values aren't stored, got ${JSON.stringify(two)}`);
  const bpm = getTracksByIds(db, [trackOf('A/01 One.mp3')]).get(trackOf('A/01 One.mp3'))!.bpm;
  assert(bpm?.provider === 'rekordbox' && bpm.value === 122, `shown BPM is rekordbox's, got ${JSON.stringify(bpm)}`);
  console.log('ok import');
}
{
  const before = JSON.stringify(facetRows());
  importRekordbox(db, xmlPath, readRekordboxCollection(xmlPath));
  assert(JSON.stringify(facetRows()) === before, 'a second import changes nothing');
  writeFileSync(xmlPath, exportXml({ dropTwo: true }));
  const s = importRekordbox(db, xmlPath, readRekordboxCollection(xmlPath));
  assert(s.matched === 2, `two matched after the drop, got ${s.matched}`);
  assert(Object.keys(facetsOf(trackOf('A/02 Two.mp3'))).length === 0, 'an entry dropped from the export takes its facts with it');
  assert(facetsOf(trackOf('A/01 One.mp3')).key === 'Am', 'others keep theirs');
  console.log('ok re-import');
}

console.log('PASS verify-rekordbox-catalog');
