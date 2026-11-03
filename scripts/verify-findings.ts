/**
 * The "needs attention" list. Load-bearing claims:
 *  - an excluded file stops being a track and stays out on later syncs;
 *  - missing, duplicate and unsupported files raise findings that clear
 *    themselves when the problem goes away and reopen when it returns;
 *  - a settled finding stays settled, and a third copy is a new finding;
 *  - keep-one moves stars, notes and playlist entries; forget drops them;
 *  - a track whose file is missing is not playable.
 * Temp dirs and an in-memory database only.
 *
 * Run: bun verify scripts/verify-findings.ts
 */
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runMigrations } from '../src/lib/server/db/migrate';
import { collate } from '../src/lib/server/library/collate';
import type { FileListDeps } from '../src/lib/server/library/fileList';
import type { FileTags } from '../src/lib/server/library/tags';
import { buildLocalResult, type Catalog } from '../src/lib/server/sources/local/localResult';
import { releaseIdForTags } from '../src/lib/server/sources/local/sync';

function fail(msg: string): never { console.error(`FAIL: ${msg}`); process.exit(1); }
function assert(cond: unknown, msg: string): asserts cond { if (!cond) fail(msg); }

const root = mkdtempSync(join(tmpdir(), 'booth-findings-'));
const p = (name: string) => join(root, name);
/** A fake audio file: line 1 is the audio (fingerprinted), line 2 the title tag. "UNREADABLE" refuses tag reads. */
function write(name: string, audio: string, title: string) {
  mkdirSync(dirname(p(name)), { recursive: true });
  writeFileSync(p(name), `${audio}\n${title}\n`);
}
const deps: FileListDeps = {
  async fingerprint(path) { return createHash('md5').update(readFileSync(path, 'utf8').split('\n')[0]).digest('hex'); },
  async readTags(path): Promise<FileTags> {
    const [, title] = readFileSync(path, 'utf8').split('\n');
    if (title === 'UNREADABLE') throw new Error('unsupported format');
    return { title, artist: 'Artist', album: 'Album', year: 2020, trackNumber: 1, booth: {} };
  },
};

const db = new Database(':memory:');
db.exec('PRAGMA foreign_keys = ON');
runMigrations(db);

const RELEASE = 'itunes-album:abc';
type Listed = { pid: string; name: string; pos: number; title: string };
function catalog(listed: Listed[]): Catalog {
  return {
    id: 'music',
    releases: [{ externalId: RELEASE, title: 'Album', artist: 'Artist', year: 2021 }],
    tracks: listed.map((t) => ({
      catalogId: t.pid,
      path: p(t.name),
      track: { title: t.title, artist: 'Artist', album: 'Album', position: String(t.pos), releaseExternalId: RELEASE, facets: {} },
    })),
  };
}
/** One local sync: build from the file list, collate. Returns the result for refreshFindings. */
async function sync(listed: Listed[]) {
  const built = await buildLocalResult(db, { catalogs: [catalog(listed)], boothFiles: [], groupIdFor: releaseIdForTags }, deps);
  collate(db, 'local', { tracks: built.tracks, releases: built.releases });
  return built;
}
const trackTitles = () => (db.prepare(`SELECT title FROM track ORDER BY title`).all() as { title: string }[]).map((r) => r.title);
const fileId = (name: string) => (db.prepare(`SELECT id FROM audio_file WHERE path = ?`).get(p(name)) as { id: string }).id;

// --- Task 1: an excluded file leaves the library and stays out ------------
write('A/01.mp3', 'AUDIO-1', 'One');
write('A/02.mp3', 'AUDIO-2', 'Two');
const two: Listed[] = [
  { pid: 'P1', name: 'A/01.mp3', pos: 1, title: 'One' },
  { pid: 'P2', name: 'A/02.mp3', pos: 2, title: 'Two' },
];
{
  const built = await sync(two);
  assert(trackTitles().join() === 'One,Two', `two tracks before exclusion, got ${trackTitles()}`);
  assert(built.fileIds.length === 2, `fileIds lists the files this sync asked about, got ${built.fileIds.length}`);
  db.prepare(`UPDATE audio_file SET excluded = 1 WHERE id = ?`).run(fileId('A/02.mp3'));
  await sync(two);
  assert(trackTitles().join() === 'One', `excluded file's track pruned, got ${trackTitles()}`);
  await sync(two);
  assert(trackTitles().join() === 'One', `excluded file stays out on a later sync, got ${trackTitles()}`);
  assert(db.prepare(`SELECT 1 FROM audio_file WHERE path = ?`).get(p('A/02.mp3')), 'the file row itself stays');
  db.prepare(`UPDATE audio_file SET excluded = 0 WHERE id = ?`).run(fileId('A/02.mp3'));
  await sync(two);
  assert(trackTitles().join() === 'One,Two', `un-excluding brings the track back, got ${trackTitles()}`);
  console.log('ok exclusion');
}

// --- Task 2: raise, clear, reopen, settled stays settled -------------------
const { refreshFindings } = await import('../src/lib/server/library/findings');
const findings = () => db.prepare(`SELECT kind, state, file_ids FROM finding ORDER BY kind, raised_at`).all() as { kind: string; state: string; file_ids: string }[];
const openOf = (kind: string) => findings().filter((f) => f.kind === kind && f.state === 'open');
{
  // Clean library: nothing to report.
  let built = await sync(two);
  let s = refreshFindings(db, 'run-1', built.fileIds);
  assert(s.new === 0 && s.open === 0, `clean library raises nothing, got ${JSON.stringify(s)}`);

  // A missing file is raised once, not again on the next sync.
  renameSync(p('A/02.mp3'), p('elsewhere-02.mp3'));
  built = await sync(two);
  s = refreshFindings(db, 'run-2', built.fileIds);
  assert(s.new === 1 && openOf('missing').length === 1, `missing raised, got ${JSON.stringify(s)}`);
  built = await sync(two);
  s = refreshFindings(db, 'run-3', built.fileIds);
  assert(s.new === 0 && s.open === 1, `missing not raised twice, got ${JSON.stringify(s)}`);

  // It comes back: clears itself. It goes again: the same row reopens.
  renameSync(p('elsewhere-02.mp3'), p('A/02.mp3'));
  built = await sync(two);
  s = refreshFindings(db, 'run-4', built.fileIds);
  assert(s.cleared === 1 && s.open === 0, `returning file clears, got ${JSON.stringify(s)}`);
  renameSync(p('A/02.mp3'), p('elsewhere-02.mp3'));
  built = await sync(two);
  s = refreshFindings(db, 'run-5', built.fileIds);
  assert(s.new === 1 && findings().filter((f) => f.kind === 'missing').length === 1, `same problem reopens the same row, got ${JSON.stringify(findings())}`);
  renameSync(p('elsewhere-02.mp3'), p('A/02.mp3'));
  refreshFindings(db, 'run-6', (await sync(two)).fileIds);
  console.log('ok missing raise/clear/reopen');

  // Duplicates: a copy of One listed as a third track.
  write('B/01 copy.mp3', 'AUDIO-1', 'One copy');
  const three: Listed[] = [...two, { pid: 'P3', name: 'B/01 copy.mp3', pos: 3, title: 'One copy' }];
  built = await sync(three);
  s = refreshFindings(db, 'run-7', built.fileIds);
  assert(openOf('duplicate').length === 1, `duplicate raised, got ${JSON.stringify(findings())}`);
  const dupId = (db.prepare(`SELECT id FROM finding WHERE kind='duplicate'`).get() as { id: string }).id;

  // Settled stays settled across syncs.
  db.prepare(`UPDATE finding SET state='settled', resolution='keep_both' WHERE id = ?`).run(dupId);
  built = await sync(three);
  s = refreshFindings(db, 'run-8', built.fileIds);
  assert(s.new === 0 && openOf('duplicate').length === 0, `settled duplicate stays settled, got ${JSON.stringify(findings())}`);

  // A third copy is a new circumstance: a new finding; the settled pair stays settled.
  write('C/01 again.mp3', 'AUDIO-1', 'One again');
  const four: Listed[] = [...three, { pid: 'P4', name: 'C/01 again.mp3', pos: 4, title: 'One again' }];
  built = await sync(four);
  s = refreshFindings(db, 'run-9', built.fileIds);
  assert(s.new === 1 && openOf('duplicate').length === 1, `third copy raises a new finding, got ${JSON.stringify(findings())}`);
  assert((db.prepare(`SELECT state FROM finding WHERE id = ?`).get(dupId) as { state: string }).state === 'settled', 'the settled pair stays settled');
  assert((JSON.parse(openOf('duplicate')[0].file_ids) as string[]).length === 3, 'the new finding names all three files');
  console.log('ok duplicate settled/third copy');

  // Unsupported: a file whose tags can't be read.
  write('D/broken.mp3', 'AUDIO-9', 'UNREADABLE');
  const five: Listed[] = [...four, { pid: 'P5', name: 'D/broken.mp3', pos: 5, title: 'Broken' }];
  built = await sync(five);
  s = refreshFindings(db, 'run-10', built.fileIds);
  assert(openOf('unsupported').length === 1, `unsupported raised, got ${JSON.stringify(findings())}`);

  // Excluded files raise nothing: exclude the broken one.
  db.prepare(`UPDATE audio_file SET excluded = 1 WHERE path = ?`).run(p('D/broken.mp3'));
  built = await sync(five);
  s = refreshFindings(db, 'run-11', built.fileIds);
  assert(openOf('unsupported').length === 0, `excluded file's finding clears, got ${JSON.stringify(findings())}`);
  db.prepare(`UPDATE audio_file SET excluded = 0 WHERE path = ?`).run(p('D/broken.mp3'));
  console.log('ok unsupported, excluded ignored');

  // Leave the library as five-listed for Task 3.
  refreshFindings(db, 'run-12', (await sync(five)).fileIds);
}

// --- Task 3: settling --------------------------------------------------------
const { listOpenFindings, settleFinding, settleAllOfKind, openFindingCount } = await import('../src/lib/server/library/findings');
const { createPlaylist, addTrack } = await import('../src/lib/server/library/playlists');
const trackOfPath = (name: string) => (db.prepare(
  `SELECT sl.entity_id AS id FROM source_link sl JOIN audio_file f ON f.id = sl.external_id
    WHERE sl.source = 'local' AND sl.entity_kind = 'track' AND f.path = ?`,
).get(p(name)) as { id: string } | null)?.id ?? null;
{
  const five: Listed[] = [
    ...two,
    { pid: 'P3', name: 'B/01 copy.mp3', pos: 3, title: 'One copy' },
    { pid: 'P4', name: 'C/01 again.mp3', pos: 4, title: 'One again' },
    { pid: 'P5', name: 'D/broken.mp3', pos: 5, title: 'Broken' },
  ];

  // The view names each file and what hangs off its track.
  const original = trackOfPath('A/01.mp3')!;
  const copy = trackOfPath('B/01 copy.mp3')!;
  db.prepare(`UPDATE track SET starred_at = '2026-01-01', note = 'copy note' WHERE id = ?`).run(copy);
  const pl = createPlaylist(db, 'Warmup');
  addTrack(db, pl.id, copy);
  const dup = listOpenFindings(db).find((f) => f.kind === 'duplicate')!;
  const copyFile = dup.files.find((f) => f.path === p('B/01 copy.mp3'))!;
  assert(copyFile.starred && copyFile.note === 'copy note' && copyFile.playlists.join() === 'Warmup', `view shows the copy's annotations, got ${JSON.stringify(copyFile)}`);

  // Keep one: the others leave the library; their star, note and playlist entry move to the kept track.
  const keep = dup.files.find((f) => f.path === p('A/01.mp3'))!.fileId;
  const r = settleFinding(db, dup.id, { type: 'keep_one', fileId: keep });
  assert(r.needsSync, 'keep one asks for a sync so the others leave');
  await sync(five);
  assert(!trackOfPath('B/01 copy.mp3') && !trackOfPath('C/01 again.mp3'), 'the other copies are no longer tracks');
  const kept = db.prepare(`SELECT starred_at, note FROM track WHERE id = ?`).get(original) as { starred_at: string | null; note: string | null };
  assert(kept.starred_at && kept.note === 'copy note', `star and note moved to the kept track, got ${JSON.stringify(kept)}`);
  assert(db.prepare(`SELECT 1 FROM playlist_track WHERE playlist_id = ? AND track_id = ?`).get(pl.id, original), 'playlist entry moved to the kept track');
  let s = refreshFindings(db, 'run-13', (await sync(five)).fileIds);
  assert(s.new === 0 && listOpenFindings(db).every((f) => f.kind !== 'duplicate'), `no duplicate comes back, got ${JSON.stringify(listOpenFindings(db))}`);
  assert(readFileSync(p('B/01 copy.mp3'), 'utf8').startsWith('AUDIO-1'), 'the file itself is untouched');
  console.log('ok keep one');

  // Forget a missing track: it and its playlist entries go; the decision holds.
  renameSync(p('A/02.mp3'), p('gone-02.mp3'));
  refreshFindings(db, 'run-14', (await sync(five)).fileIds);
  const two2 = trackOfPath('A/02.mp3')!;
  addTrack(db, pl.id, two2);
  const missing = listOpenFindings(db).find((f) => f.kind === 'missing')!;
  assert(missing.files[0].playlists.join() === 'Warmup', 'forget shows the playlists first');
  const forgot = settleFinding(db, missing.id, { type: 'forget' });
  await sync(five);
  forgot.afterSync?.();
  assert(!trackOfPath('A/02.mp3'), 'forgotten track is gone');
  assert(!db.prepare(`SELECT 1 FROM playlist_track WHERE playlist_id = ? AND snap_title = 'Two'`).get(pl.id), 'forget removed the playlist entry rather than leaving it for relink');
  s = refreshFindings(db, 'run-15', (await sync(five)).fileIds);
  assert(s.new === 0 && openFindingCount(db) === 1, `forgotten file raises nothing; only unsupported remains, got ${JSON.stringify(listOpenFindings(db))}`);
  console.log('ok forget');

  // Wrong action for the kind is refused.
  const uns = listOpenFindings(db).find((f) => f.kind === 'unsupported')!;
  let refused = false;
  try { settleFinding(db, uns.id, { type: 'forget' }); } catch { refused = true; }
  assert(refused, 'forget is not an action for an unsupported file');

  // Bulk: the non-destructive action, and it says how many.
  assert(settleAllOfKind(db, 'unsupported') === 1, 'bulk acknowledge settles one');
  assert(openFindingCount(db) === 0, 'nothing open after bulk');
  refreshFindings(db, 'run-16', (await sync(five)).fileIds);
  assert(openFindingCount(db) === 0, 'acknowledged stays settled');
  console.log('ok bulk, refusals');
}

// --- Task 4: a missing file isn't playable ----------------------------------
const { getTracksByIds, listTracks } = await import('../src/lib/server/library/queries');
{
  const five: Listed[] = [
    ...two,
    { pid: 'P3', name: 'B/01 copy.mp3', pos: 3, title: 'One copy' },
    { pid: 'P4', name: 'C/01 again.mp3', pos: 4, title: 'One again' },
    { pid: 'P5', name: 'D/broken.mp3', pos: 5, title: 'Broken' },
  ];
  const one = trackOfPath('A/01.mp3')!;
  assert(getTracksByIds(db, [one]).get(one)!.canPlay, 'present file plays');
  renameSync(p('A/01.mp3'), p('gone-01.mp3'));
  await sync(five);
  assert(!getTracksByIds(db, [one]).get(one)!.canPlay, 'missing file: not playable (by id)');
  const listed = listTracks(db, { limit: 50, offset: 0 } as Parameters<typeof listTracks>[1]).items.find((t) => t.id === one)!;
  assert(!listed.canPlay, 'missing file: not playable (track list)');
  renameSync(p('gone-01.mp3'), p('A/01.mp3'));
  await sync(five);
  assert(getTracksByIds(db, [one]).get(one)!.canPlay, 'file back: playable again');
  console.log('ok missing not playable');
}

console.log('PASS verify-findings');
