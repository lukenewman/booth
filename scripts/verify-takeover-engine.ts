/**
 * The takeover engine (BOO-102 step 6a). Load-bearing claims:
 *  - a release's files are copied into Booth's folder with Booth's facts and
 *    names in their tags, checked, and the release's tracks switch to the
 *    copies; the originals are byte-for-byte untouched;
 *  - a sync afterwards changes nothing (same tracks, stars, playlists, no findings);
 *  - one bad file fails the whole release: nothing flips, no copy is left,
 *    and a takeover finding says why;
 *  - an interrupted run leaves nothing half-done, and resuming finishes it;
 *  - an untaggable file is copied verbatim; a release already taken over
 *    gets no second copy; too little space refuses before copying.
 * Temp dirs, an in-memory database and fake audio (line 1 is the "audio").
 *
 * Run: bun verify scripts/verify-takeover-engine.ts
 */
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { runMigrations } from '../src/lib/server/db/migrate';
import { collate } from '../src/lib/server/library/collate';
import type { FileListDeps } from '../src/lib/server/library/fileList';
import type { FileTags } from '../src/lib/server/library/tags';
import { toTagWrite, type BoothTrackFacts } from '../src/lib/server/library/tag_schema';
import { refreshFindings, listOpenFindings } from '../src/lib/server/library/findings';
import { createPlaylist, addTrack } from '../src/lib/server/library/playlists';
import { buildLocalResult } from '../src/lib/server/sources/local/localResult';
import { listAudioFiles } from '../src/lib/server/sources/local/ingest';
import { releaseIdForTags } from '../src/lib/server/sources/local/sync';
import { createTakeoverRun, runTakeover, type TakeoverDeps } from '../src/lib/server/takeover/engine';

function fail(msg: string): never { console.error(`FAIL: ${msg}`); process.exit(1); }
function assert(cond: unknown, msg: string): asserts cond { if (!cond) fail(msg); }

const root = mkdtempSync(join(tmpdir(), 'booth-takeover-engine-'));
const p = (n: string) => join(root, n);
const booth = p('Booth');
mkdirSync(booth);
const md5 = (s: string) => createHash('md5').update(s).digest('hex');
const audioOf = (path: string) => readFileSync(path, 'utf8').split('\n')[0];
/** An original: line 1 the audio, line 2 the title, line 3 the track number. A Booth copy: line 2 is JSON. */
const write = (n: string, audio: string, title: string, no = 1) => { mkdirSync(dirname(p(n)), { recursive: true }); writeFileSync(p(n), `${audio}\n${title}\n${no}\n`); };
function fakeTags(path: string): FileTags {
  const [, line2, line3] = readFileSync(path, 'utf8').split('\n');
  if (line2?.startsWith('{')) {
    const w = JSON.parse(line2) as ReturnType<typeof toTagWrite>;
    const booth: Record<string, string> = {};
    for (const [k, v] of Object.entries(w.custom)) booth[k.replace(/^BOOTH_/, '')] = v;
    return { title: w.names?.title, artist: w.names?.artist, album: w.names?.album, albumArtist: w.names?.albumArtist, year: w.names?.year, trackNumber: w.names?.trackNumber, comment: w.comment, bpm: w.bpm, booth };
  }
  return { title: line2, artist: 'Artist', album: 'Album', year: 2021, trackNumber: Number(line3), booth: {} };
}
const listDeps: FileListDeps = { async fingerprint(path) { return md5(audioOf(path)); }, async readTags(path) { return fakeTags(path); } };

let free = 1e12;
let corrupt: string | null = null;
let crashAfter: string | null = null;
const deps: TakeoverDeps = {
  fingerprint: listDeps.fingerprint,
  readTags: async (path) => fakeTags(path),
  freeBytes: () => free,
  async writeTags(source: string, facts: BoothTrackFacts, dest: string) {
    const audio = audioOf(source) + (corrupt && source.endsWith(corrupt) ? '-damaged' : '');
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, `${audio}\n${JSON.stringify(toTagWrite(facts))}\n`);
    if (crashAfter && source.endsWith(crashAfter)) throw new Error('simulated crash');
    return md5(audio);
  },
};

const db = new Database(':memory:');
db.exec('PRAGMA foreign_keys = ON');
runMigrations(db);

write('Music/Artist/Album/01 One.mp3', 'AUD1', 'One', 1);
write('Music/Artist/Album/02 Two.mp3', 'AUD2', 'Two', 2);
write('Music/Other/Live/01 Jam.wav', 'AUD3', 'Jam', 1);
write('Music/Third/EP/01 A.mp3', 'AUD4', 'A', 1);
write('Music/Third/EP/02 B.mp3', 'AUD5', 'B', 2);
const listed = [
  { pid: 'P1', name: 'Music/Artist/Album/01 One.mp3', rel: 'rel1', album: 'Album', artist: 'Artist', pos: 1, title: 'One' },
  { pid: 'P2', name: 'Music/Artist/Album/02 Two.mp3', rel: 'rel1', album: 'Album', artist: 'Artist', pos: 2, title: 'Two' },
  { pid: 'P3', name: 'Music/Other/Live/01 Jam.wav', rel: 'rel2', album: 'Live', artist: 'Other', pos: 1, title: 'Jam' },
  { pid: 'P4', name: 'Music/Third/EP/01 A.mp3', rel: 'rel3', album: 'EP', artist: 'Third', pos: 1, title: 'A' },
  { pid: 'P5', name: 'Music/Third/EP/02 B.mp3', rel: 'rel3', album: 'EP', artist: 'Third', pos: 2, title: 'B' },
];
async function sync() {
  const built = await buildLocalResult(db, {
    catalogs: [{
      id: 'music',
      releases: [...new Set(listed.map((t) => t.rel))].map((rel) => { const t = listed.find((x) => x.rel === rel)!; return { externalId: rel, title: t.album, artist: t.artist, year: 2021 }; }),
      tracks: listed.map((t) => ({ catalogId: t.pid, path: p(t.name), track: { title: t.title, artist: t.artist, album: t.album, position: String(t.pos), releaseExternalId: t.rel, facets: {} } })),
    }],
    boothFiles: listAudioFiles(booth),
    groupIdFor: releaseIdForTags,
  }, listDeps);
  const c = collate(db, 'local', { tracks: built.tracks, releases: built.releases });
  const f = refreshFindings(db, 'r', built.fileIds, { leaveAlone: built.offlineFileIds });
  return { built, collate: c, findings: f };
}
const releaseOf = (title: string) => (db.prepare(`SELECT release_id AS r FROM track WHERE title = ?`).get(title) as { r: string }).r;
const snapshot = () => JSON.stringify({
  tracks: db.prepare(`SELECT id, title, release_id, starred_at, note FROM track ORDER BY id`).all(),
  playlists: db.prepare(`SELECT playlist_id, track_id FROM playlist_track ORDER BY track_id`).all(),
});
const fileOfTrack = (title: string) => db.prepare(`SELECT f.* FROM track t JOIN source_link sl ON sl.entity_id = t.id AND sl.source = 'local' JOIN audio_file f ON f.id = sl.external_id WHERE t.title = ?`).get(title) as { id: string; path: string; ownership: string; copy_of: string | null };
const originals = () => listed.slice(0, 5).map((t) => { const st = statSync(p(t.name)); return `${t.name}:${st.size}:${st.mtimeMs}:${md5(readFileSync(p(t.name), 'utf8'))}`; }).join('|');
const stagingLeft = () => existsSync(join(booth, '.booth-takeover')) ? readdirSync(join(booth, '.booth-takeover'), { recursive: true }).filter((n) => String(n).includes('.')).length : 0;

await sync();
const one = db.prepare(`SELECT id FROM track WHERE title = 'One'`).get() as { id: string };
db.prepare(`UPDATE track SET starred_at = '2026-01-01', note = 'peak time' WHERE id = ?`).run(one.id);
addTrack(db, createPlaylist(db, 'Set').id, one.id);
const origBefore = originals();

// --- a release is taken over ----------------------------------------------------------
{
  const before = snapshot();
  const runId = createTakeoverRun(db, [releaseOf('One')]);
  const r = await runTakeover(db, deps, runId, { root: booth });
  assert(r.state === 'done' && r.done === 1 && r.failed === 0, `the release is taken over, got ${JSON.stringify(r)}`);
  const f1 = fileOfTrack('One');
  assert(f1.ownership === 'booth' && f1.copy_of && f1.path === join(booth, 'Artist', 'Album', '01 One.mp3'), `the track points at its copy in Booth's folder, got ${JSON.stringify(f1)}`);
  const tags = fakeTags(f1.path);
  assert(tags.title === 'One' && tags.album === 'Album' && tags.trackNumber === 1 && tags.booth.STARRED === '1' && tags.comment === 'peak time', `facts and names are in the copy's tags, got ${JSON.stringify(tags)}`);
  assert(originals() === origBefore, 'the originals are untouched');
  assert(snapshot() === before, 'tracks, stars and playlists are as they were');
  const s = await sync();
  assert(s.collate.tracksDeleted === 0 && snapshot() === before && fileOfTrack('One').id === f1.id, 'a sync afterwards changes nothing');
  assert(listOpenFindings(db).length === 0, `and raises nothing, got ${JSON.stringify(listOpenFindings(db))}`);
  assert(stagingLeft() === 0, 'no staging left behind');
  console.log('ok take over');

  // Again: already taken over, so no second copy.
  const again = await runTakeover(db, deps, createTakeoverRun(db, [releaseOf('One')]), { root: booth });
  assert(again.failed === 0 && listAudioFiles(booth).length === 2, `no second copy, got ${JSON.stringify(again)} ${listAudioFiles(booth)}`);
  console.log('ok no second copy');
}

// --- an untaggable file is copied verbatim -----------------------------------------------
{
  const r = await runTakeover(db, deps, createTakeoverRun(db, [releaseOf('Jam')]), { root: booth });
  const f = fileOfTrack('Jam');
  assert(r.done === 1 && f.ownership === 'booth' && readFileSync(f.path, 'utf8') === readFileSync(p('Music/Other/Live/01 Jam.wav'), 'utf8'), `a WAV is copied byte for byte, got ${JSON.stringify(r)}`);
  await sync();
  assert(listOpenFindings(db).length === 0, `and raises nothing, got ${JSON.stringify(listOpenFindings(db))}`);
  console.log('ok verbatim copy');
}

// --- one bad file fails the release --------------------------------------------------------
{
  const rel = releaseOf('A');
  corrupt = '02 B.mp3';
  const r = await runTakeover(db, deps, createTakeoverRun(db, [rel]), { root: booth });
  corrupt = null;
  assert(r.failed === 1 && r.done === 0, `the release fails, got ${JSON.stringify(r)}`);
  assert(fileOfTrack('A').ownership === 'in_place' && fileOfTrack('B').ownership === 'in_place', 'neither track flipped');
  assert(!listAudioFiles(booth).some((x) => x.includes('/Third/')) && stagingLeft() === 0, 'no copies left behind');
  const tk = listOpenFindings(db).find((x) => x.kind === 'takeover');
  assert(tk && /audio/i.test(tk.detail ?? ''), `a takeover finding says why, got ${JSON.stringify(listOpenFindings(db))}`);
  await sync();
  assert(listOpenFindings(db).some((x) => x.kind === 'takeover'), 'a sync leaves it');
  console.log('ok failed release');

  // Interrupted mid-release (a crash after one file): nothing flipped; the next run finishes it.
  crashAfter = '02 B.mp3';
  const runId = createTakeoverRun(db, [rel]);
  const crashed = await runTakeover(db, deps, runId, { root: booth });
  crashAfter = null;
  assert(crashed.done === 0 && fileOfTrack('A').ownership === 'in_place', `nothing flips on a crash, got ${JSON.stringify(crashed)}`);
  // A real crash leaves staged files and the release pending; simulate the leftovers.
  db.prepare(`UPDATE takeover_release SET state = 'pending', error = NULL WHERE run_id = ?`).run(runId);
  db.prepare(`UPDATE takeover_run SET state = 'running' WHERE id = ?`).run(runId);
  const orphan = join(booth, '.booth-takeover', runId, 'Third', 'EP', '01 A.mp3');
  mkdirSync(dirname(orphan), { recursive: true });
  writeFileSync(orphan, 'AUD4\n{}\n');
  const resumed = await runTakeover(db, deps, runId, { root: booth });
  assert(resumed.done === 1 && fileOfTrack('A').ownership === 'booth' && fileOfTrack('B').ownership === 'booth', `resuming finishes it, got ${JSON.stringify(resumed)}`);
  assert(stagingLeft() === 0 && listAudioFiles(booth).filter((x) => x.includes('/Third/')).length === 2, 'with exactly one copy each and no leftovers');
  assert(!listOpenFindings(db).some((x) => x.kind === 'takeover'), 'and its finding clears');
  console.log('ok interrupted and resumed');
}

// --- not enough space ----------------------------------------------------------------------
{
  write('Music/Fourth/Single/01 S.mp3', 'AUD6', 'S', 1);
  listed.push({ pid: 'P6', name: 'Music/Fourth/Single/01 S.mp3', rel: 'rel4', album: 'Single', artist: 'Fourth', pos: 1, title: 'S' });
  await sync();
  free = 3;
  const r = await runTakeover(db, deps, createTakeoverRun(db, [releaseOf('S')]), { root: booth });
  free = 1e12;
  assert(r.state === 'failed' && /space/i.test(r.error ?? '') && !listAudioFiles(booth).some((x) => x.includes('Fourth')), `refused for space before copying, got ${JSON.stringify(r)}`);
  console.log('ok space');
}

assert(originals() === origBefore, 'after everything, the originals are untouched');
console.log(`PASS verify-takeover-engine (${relative(root, booth)})`);
