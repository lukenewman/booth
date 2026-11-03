/**
 * Takeover (BOO-102 step 6a). Load-bearing claims, grown task by task:
 *  - a copy Booth made of a file is that file's track from then on: same
 *    track id, same stars and playlists, and a sync afterwards changes nothing;
 *  - a copy that goes missing is reported like any missing file, never
 *    silently swapped back for the original;
 *  - Booth's folder can't be put where it would mix with other files.
 * Temp dirs and an in-memory database only.
 *
 * Run: bun verify scripts/verify-takeover.ts
 */
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ulid } from 'ulid';
import { runMigrations } from '../src/lib/server/db/migrate';
import { collate } from '../src/lib/server/library/collate';
import type { FileListDeps } from '../src/lib/server/library/fileList';
import type { FileTags } from '../src/lib/server/library/tags';
import { refreshFindings, listOpenFindings } from '../src/lib/server/library/findings';
import { createPlaylist, addTrack } from '../src/lib/server/library/playlists';
import { buildLocalResult } from '../src/lib/server/sources/local/localResult';
import { listAudioFiles } from '../src/lib/server/sources/local/ingest';
import { releaseIdForTags } from '../src/lib/server/sources/local/sync';
import { checkBoothFolder } from '../src/lib/server/library/boothFolder';

function fail(msg: string): never { console.error(`FAIL: ${msg}`); process.exit(1); }
function assert(cond: unknown, msg: string): asserts cond { if (!cond) fail(msg); }

const root = mkdtempSync(join(tmpdir(), 'booth-takeover-'));
const p = (n: string) => join(root, n);
const booth = p('Booth');
mkdirSync(booth);
/** Line 1 the audio, line 2 the title tag, line 3 the track number tag. */
const write = (n: string, audio: string, title: string, no = 1) => { mkdirSync(dirname(p(n)), { recursive: true }); writeFileSync(p(n), `${audio}\n${title}\n${no}\n`); };
const deps: FileListDeps = {
  async fingerprint(path) { return createHash('md5').update(readFileSync(path, 'utf8').split('\n')[0]).digest('hex'); },
  async readTags(path): Promise<FileTags> {
    const [, title, no] = readFileSync(path, 'utf8').split('\n');
    return { title, artist: 'Artist', album: 'Album', year: 2021, trackNumber: Number(no), booth: {} };
  },
};

const db = new Database(':memory:');
db.exec('PRAGMA foreign_keys = ON');
runMigrations(db);

write('Music/Artist/Album/01 One.mp3', 'AUD1', 'One', 1);
write('Music/Artist/Album/02 Two.mp3', 'AUD2', 'Two', 2);
const listed = [
  { pid: 'P1', path: p('Music/Artist/Album/01 One.mp3'), pos: 1, title: 'One' },
  { pid: 'P2', path: p('Music/Artist/Album/02 Two.mp3'), pos: 2, title: 'Two' },
];

async function sync() {
  const built = await buildLocalResult(db, {
    catalogs: [{
      id: 'music',
      releases: [{ externalId: 'rel', title: 'Album', artist: 'Artist', year: 2021 }],
      tracks: listed.map((t) => ({ catalogId: t.pid, path: t.path, track: { title: t.title, artist: 'Artist', album: 'Album', position: String(t.pos), releaseExternalId: 'rel', facets: {} } })),
    }],
    boothFiles: listAudioFiles(booth),
    groupIdFor: releaseIdForTags,
  }, deps);
  const c = collate(db, 'local', { tracks: built.tracks, releases: built.releases });
  const f = refreshFindings(db, 'r', built.fileIds, { leaveAlone: built.offlineFileIds });
  return { built, collate: c, findings: f };
}
const tracks = () => db.prepare(`SELECT t.id, t.title, sl.external_id AS fileId FROM track t JOIN source_link sl ON sl.entity_id = t.id AND sl.source = 'local' ORDER BY t.title`).all() as { id: string; title: string; fileId: string }[];
const fileOf = (path: string) => db.prepare(`SELECT id FROM audio_file WHERE path = ?`).get(path) as { id: string };

/** What the takeover engine does for one file, by hand: copy, record, re-point. */
function fakeCopy(original: string, copyPath: string) {
  mkdirSync(dirname(copyPath), { recursive: true });
  copyFileSync(original, copyPath);
  const orig = fileOf(original);
  const id = ulid();
  const fp = createHash('md5').update(readFileSync(copyPath, 'utf8').split('\n')[0]).digest('hex');
  db.prepare(`INSERT INTO audio_file (id, path, fingerprint, ownership, copy_of) VALUES (?, ?, ?, 'booth', ?)`).run(id, copyPath, fp, orig.id);
  db.prepare(`UPDATE source_link SET external_id = ? WHERE source = 'local' AND entity_kind = 'track' AND external_id = ?`).run(id, orig.id);
  return id;
}

// --- a copy stands in for its original --------------------------------------------
{
  await sync();
  const before = tracks();
  assert(before.length === 2, 'scenario: two tracks');
  db.prepare(`UPDATE track SET starred_at = '2026-01-01' WHERE id = ?`).run(before[0].id);
  const pl = createPlaylist(db, 'Set');
  addTrack(db, pl.id, before[0].id);

  const copyPath = join(booth, 'Artist/Album/01 One.mp3');
  const copyId = fakeCopy(listed[0].path, copyPath);
  const s = await sync();
  const after = tracks();
  assert(s.collate.tracksDeleted === 0 && after.length === 2, `no track lost or added, got ${JSON.stringify(after)}`);
  assert(after.find((t) => t.id === before[0].id)?.fileId === copyId, `the track points at the copy, got ${JSON.stringify(after)}`);
  assert(db.prepare(`SELECT starred_at FROM track WHERE id = ?`).get(before[0].id), 'its star stays');
  assert((db.prepare(`SELECT COUNT(*) AS n FROM playlist_track WHERE track_id = ?`).get(before[0].id) as { n: number }).n === 1, 'and its playlist entry');
  const again = await sync();
  assert(again.collate.tracksDeleted === 0 && JSON.stringify(tracks()) === JSON.stringify(after), 'a second sync changes nothing');
  console.log('ok copy stands in');

  // A copy that goes missing is a missing finding, and the track stays on it.
  rmSync(copyPath);
  const m = await sync();
  assert(tracks().find((t) => t.id === before[0].id)?.fileId === copyId, 'still the copy, not silently the original');
  assert(listOpenFindings(db).some((f) => f.kind === 'missing' && f.files.some((x) => x.fileId === copyId)), `a missing finding for the copy, got ${JSON.stringify(m.findings)}`);
  copyFileSync(listed[0].path, copyPath);
  await sync();
  assert(!listOpenFindings(db).some((f) => f.kind === 'missing'), 'it clears when the copy is back');
  console.log('ok missing copy');
}

// --- where Booth's folder may live ---------------------------------------------------
{
  const forbidden = [
    { path: p('Music'), why: 'music' },
    { path: p('Backups'), why: 'backup' },
  ];
  const refused = (path: string, current = { path: p('Empty'), hasFiles: false }) => { try { checkBoothFolder(path, { current, forbidden }); return false; } catch { return true; } };
  assert(refused('relative/Booth'), 'a relative path is refused');
  assert(refused(p('Music/Booth')), 'inside the music library is refused');
  assert(refused(p('Backups/x')), 'inside a backup is refused');
  assert(refused(root), 'a folder holding the library is refused');
  assert(refused(p('New Booth'), { path: booth, hasFiles: true }), 'moving away from a folder that holds files is refused');
  assert(!refused(p('New Booth')), 'a fresh folder elsewhere is fine');
  assert(!refused(booth, { path: booth, hasFiles: true }), 'choosing the current folder again is fine');
  console.log('ok booth folder');
}

// --- findings, rekordbox and backups know about copies ------------------------------
{
  const { importRekordbox } = await import('../src/lib/server/library/rekordbox');
  const { addDestination, backupStatus, runLibraryBackup } = await import('../src/lib/server/backup/library');
  const one = tracks().find((t) => t.title === 'One')!;

  // Original and copy share their audio: that's not a duplicate.
  let s = await sync();
  assert(!listOpenFindings(db).some((f) => f.kind === 'duplicate'), `original + copy is no duplicate, got ${JSON.stringify(listOpenFindings(db))}`);
  // A superseded original going away (cutover moves it) is expected, not missing.
  const orig = listed[0].path;
  const kept = orig + '.kept';
  copyFileSync(orig, kept); rmSync(orig);
  s = await sync();
  assert(!listOpenFindings(db).some((f) => f.kind === 'missing'), `a superseded original away is fine, got ${JSON.stringify(listOpenFindings(db))}`);
  copyFileSync(kept, orig); rmSync(kept);
  await sync();
  // A takeover finding is the engine's, not the sync's: a sync doesn't clear it.
  db.prepare(`INSERT INTO finding (id, kind, subject_key, file_ids, detail) VALUES ('tk1', 'takeover', 'release:x', '[]', 'disk full')`).run();
  await sync();
  assert((db.prepare(`SELECT state FROM finding WHERE id = 'tk1'`).get() as { state: string }).state === 'open', 'a takeover finding survives a sync');
  db.prepare(`DELETE FROM finding WHERE id = 'tk1'`).run();
  console.log('ok findings');

  // rekordbox still lists the original's path: its facts land on the track.
  const rb = importRekordbox(db, '/x/rekordbox.xml', [{ trackId: '1', path: orig, title: 'One', artist: 'Artist', bpm: 124, key: '8A', grid: [], cues: [], rating: null, playCount: null, dateAdded: null }]);
  assert(rb.matched === 1, `rekordbox matches the original's path to the track, got ${JSON.stringify(rb)}`);
  assert(db.prepare(`SELECT 1 FROM source_facets WHERE source = 'rekordbox' AND entity_id = ?`).get(one.id), 'onto that track');
  console.log('ok rekordbox');

  // Backups hold the copy and the original it replaced (the undo path).
  const dest = p('Drive');
  mkdirSync(dest);
  addDestination(db, dest, { libraryRoots: [p('Music')] });
  const st = backupStatus(db).destinations[0];
  assert(st.filesToCopy === 3, `copy, original and the other file, got ${st.filesToCopy}`);
  const r = await runLibraryBackup(db, { fingerprint: deps.fingerprint, snapshotDb: (to) => db.exec(`VACUUM INTO '${to}'`), freeBytes: () => 1e12 }, { places: [] });
  assert(r.state === 'done' && r.filesCopied === 3 && backupStatus(db).releasesNotBackedUp === 0, `all three backed up, got ${JSON.stringify(r)}`);
  console.log('ok backups');
}

console.log('PASS verify-takeover');
