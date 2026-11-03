/**
 * The file list: one row per audio file Booth knows, identified by its audio
 * fingerprint, read through a size+mtime cache. Temp dirs and an in-memory
 * database only.
 *
 * Run: bun verify scripts/verify-file-list.ts
 */
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runMigrations } from '../src/lib/server/db/migrate';
import { FfmpegMissingError } from '../src/lib/server/analysis/decode';
import { fileByPath, scanFiles, type FileListDeps } from '../src/lib/server/library/fileList';
import type { FileTags } from '../src/lib/server/library/tags';
import { applyCatalogMoves, recordCatalogEntries } from '../src/lib/server/library/catalogs';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) fail(msg);
}

function freshDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db);
  return db;
}

// --- schema --------------------------------------------------------
{
  const db = freshDb();
  const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
  for (const c of ['id', 'path', 'fingerprint', 'fingerprint_tried', 'size', 'mtime_ms', 'tags', 'ownership', 'present', 'missing_since'])
    assert(cols('audio_file').includes(c), `audio_file.${c}`);
  for (const c of ['catalog', 'catalog_id', 'file_id', 'location', 'seen_at'])
    assert(cols('catalog_entry').includes(c), `catalog_entry.${c}`);
}

const root = mkdtempSync(join(tmpdir(), 'booth-filelist-'));
const p = (name: string) => join(root, name);

/**
 * Fakes that make the expected answers knowable: the "fingerprint" is a hash
 * of the file's first line (the "audio"), the "tags" are its second line, so a
 * retag changes the second line and must not change the fingerprint.
 */
function write(name: string, audio: string, title: string) {
  mkdirSync(dirname(p(name)), { recursive: true });
  writeFileSync(p(name), `${audio}\n${title}\n`);
}
const calls = { fingerprint: 0, readTags: 0 };
const deps: FileListDeps = {
  async fingerprint(path) {
    calls.fingerprint++;
    const audio = readFileSync(path, 'utf8').split('\n')[0];
    if (audio === 'CORRUPT') throw new Error('not audio');
    return createHash('md5').update(audio).digest('hex');
  },
  async readTags(path): Promise<FileTags> {
    calls.readTags++;
    const [audio, title] = readFileSync(path, 'utf8').split('\n');
    if (audio === 'CORRUPT') throw new Error('unreadable');
    return { title, booth: {} };
  },
};
const reset = () => { calls.fingerprint = 0; calls.readTags = 0; };
const want = (...names: string[]) => names.map((n) => ({ path: p(n), ownership: 'in_place' as const }));

// --- registering, and the read cache ------------------------------
{
  const db = freshDb();
  write('a.mp3', 'AUDIO-A', 'A');
  write('b.mp3', 'AUDIO-B', 'B');
  reset();
  const first = await scanFiles(db, want('a.mp3', 'b.mp3'), deps);
  assert(first.summary.known === 2 && first.summary.read === 2, `two files read: ${JSON.stringify(first.summary)}`);
  const a = first.files.get(p('a.mp3'))!;
  assert(a.present && a.fingerprint && a.tags?.title === 'A', `a registered: ${JSON.stringify(a)}`);

  reset();
  const second = await scanFiles(db, want('a.mp3', 'b.mp3'), deps);
  assert(calls.readTags === 0 && calls.fingerprint === 0, `unchanged files are not read again: ${JSON.stringify(calls)}`);
  assert(second.files.get(p('a.mp3'))!.id === a.id, 'same id on the second scan');

  // A retag: same audio, new tags, new mtime.
  write('a.mp3', 'AUDIO-A', 'A (retagged)');
  utimesSync(p('a.mp3'), new Date(), new Date(Date.now() + 5000));
  reset();
  const third = await scanFiles(db, want('a.mp3', 'b.mp3'), deps);
  const a3 = third.files.get(p('a.mp3'))!;
  assert(calls.readTags === 1, `only the changed file is re-read: ${calls.readTags}`);
  assert(a3.id === a.id && a3.fingerprint === a.fingerprint && a3.tags?.title === 'A (retagged)', 'retag keeps id and fingerprint, refreshes tags');
}

// --- a file that disappears keeps its row and id -------------------
{
  const db = freshDb();
  write('c.mp3', 'AUDIO-C', 'C');
  const before = (await scanFiles(db, want('c.mp3'), deps)).files.get(p('c.mp3'))!;
  rmSync(p('c.mp3'));
  const after = await scanFiles(db, want('c.mp3'), deps);
  const c = after.files.get(p('c.mp3'))!;
  assert(c.id === before.id && !c.present, `missing file keeps its id, marked absent: ${JSON.stringify(c)}`);
  assert(after.summary.missing === 1, 'counted missing');
  // A catalog can list a file that was never there: it still gets a row.
  const ghost = (await scanFiles(db, want('never.mp3'), deps)).files.get(p('never.mp3'))!;
  assert(ghost && !ghost.present && ghost.fingerprint === null, 'a never-present file gets an absent row');
}

// --- a move recognised by fingerprint ------------------------------
{
  const db = freshDb();
  write('old.mp3', 'AUDIO-MOVE', 'Moving');
  const before = (await scanFiles(db, want('old.mp3'), deps)).files.get(p('old.mp3'))!;
  renameSync(p('old.mp3'), p('new.mp3'));
  const after = await scanFiles(db, want('new.mp3'), deps);
  const moved = after.files.get(p('new.mp3'))!;
  assert(moved.id === before.id, `the moved file keeps its id: ${before.id} → ${moved.id}`);
  assert(after.summary.moved === 1, 'counted as a move');
  assert(fileByPath(db, p('old.mp3')) === null, 'no row is left at the old path');
}

// --- two copies of the same audio are two files --------------------
{
  const db = freshDb();
  write('dup1.mp3', 'AUDIO-DUP', 'Dup');
  write('dup2.mp3', 'AUDIO-DUP', 'Dup 1');
  const r = await scanFiles(db, want('dup1.mp3', 'dup2.mp3'), deps);
  const [d1, d2] = [r.files.get(p('dup1.mp3'))!, r.files.get(p('dup2.mp3'))!];
  assert(d1.id !== d2.id && d1.fingerprint === d2.fingerprint, 'duplicates stay separate rows');
  // A copy turning up while the original is still present is not a move.
  rmSync(p('dup1.mp3'));
  write('dup3.mp3', 'AUDIO-DUP', 'Dup 3');
  const r2 = await scanFiles(db, want('dup2.mp3', 'dup3.mp3'), deps);
  assert(r2.files.get(p('dup3.mp3'))!.id !== d2.id, 'a new copy never takes over a present file');
}

// --- unreadable files are registered, not fatal --------------------
{
  const db = freshDb();
  write('bad.mp3', 'CORRUPT', '');
  write('good.mp3', 'AUDIO-G', 'G');
  const r = await scanFiles(db, want('bad.mp3', 'good.mp3'), deps);
  const bad = r.files.get(p('bad.mp3'))!;
  assert(bad.present && bad.tags === null && bad.fingerprint === null, `unreadable file registered without tags: ${JSON.stringify(bad)}`);
  assert(r.files.get(p('good.mp3'))!.tags?.title === 'G', 'the rest of the scan carries on');
  assert(r.summary.unreadable.some((u) => u.path === p('bad.mp3')), 'and it is reported');
  reset();
  await scanFiles(db, want('bad.mp3', 'good.mp3'), deps);
  assert(calls.readTags === 1, `a file whose tags failed is tried again next scan: ${calls.readTags}`);

  // Tags fine but ffmpeg can't hash it: that is not retried while unchanged.
  write('nohash.mp3', 'AUDIO-NH', 'NH');
  const noHash: FileListDeps = { ...deps, async fingerprint() { calls.fingerprint++; throw new Error('ffmpeg: invalid data'); } };
  await scanFiles(db, want('nohash.mp3'), noHash);
  reset();
  await scanFiles(db, want('nohash.mp3'), noHash);
  assert(calls.fingerprint === 0 && calls.readTags === 0, `an unhashable but readable file is not retried: ${JSON.stringify(calls)}`);
}

// --- no ffmpeg: everything still registers, fingerprints wait -------
{
  const db = freshDb();
  write('e.mp3', 'AUDIO-E', 'E');
  write('f.mp3', 'AUDIO-F', 'F');
  const noFfmpeg: FileListDeps = { ...deps, async fingerprint() { throw new FfmpegMissingError(); } };
  const r = await scanFiles(db, want('e.mp3', 'f.mp3'), noFfmpeg);
  assert(r.summary.fingerprintsUnavailable, 'reports fingerprints unavailable');
  assert([...r.files.values()].every((f) => f.present && f.fingerprint === null && f.tags), 'files registered with tags, no fingerprints');
  reset();
  const later = await scanFiles(db, want('e.mp3', 'f.mp3'), deps);
  assert(calls.fingerprint === 2 && calls.readTags === 0, `once ffmpeg exists, only fingerprints are taken: ${JSON.stringify(calls)}`);
  assert([...later.files.values()].every((f) => f.fingerprint), 'and they are stored');
}

// --- an interrupted first scan resumes without duplicates ----------
{
  const db = freshDb();
  for (const n of ['r1', 'r2', 'r3', 'r4']) write(`${n}.mp3`, `AUDIO-${n}`, n);
  const half = await scanFiles(db, want('r1.mp3', 'r2.mp3'), deps);
  const ids = [...half.files.values()].map((f) => f.id);
  reset();
  const full = await scanFiles(db, want('r1.mp3', 'r2.mp3', 'r3.mp3', 'r4.mp3'), deps);
  assert(calls.readTags === 2, `only the unscanned half is read: ${calls.readTags}`);
  assert(ids.every((id) => [...full.files.values()].some((f) => f.id === id)), 'earlier ids survive');
  const rows = (db.prepare(`SELECT COUNT(*) AS n FROM audio_file`).get() as { n: number }).n;
  assert(rows === 4, `no duplicate rows: ${rows}`);
}

// --- a catalog's own id recognises a file it moved -----------------
{
  const db = freshDb();
  write('Old Album/01.mp3', 'AUDIO-CAT', 'Cat');
  const refs1 = [{ catalogId: 'PID1', path: p('Old Album/01.mp3') }];
  assert(applyCatalogMoves(db, 'music', refs1) === 0, 'nothing to move on first sight');
  const s1 = await scanFiles(db, want('Old Album/01.mp3'), deps);
  recordCatalogEntries(db, 'music', refs1, s1.files);
  const before = s1.files.get(p('Old Album/01.mp3'))!;

  // Music.app renames the folder after a retag; same Persistent ID.
  mkdirSync(p('New Album'), { recursive: true });
  renameSync(p('Old Album/01.mp3'), p('New Album/01.mp3'));
  const refs2 = [{ catalogId: 'PID1', path: p('New Album/01.mp3') }];
  assert(applyCatalogMoves(db, 'music', refs2) === 1, 'the catalog id carries the file across');
  reset();
  const s2 = await scanFiles(db, want('New Album/01.mp3'), deps);
  recordCatalogEntries(db, 'music', refs2, s2.files);
  assert(s2.files.get(p('New Album/01.mp3'))!.id === before.id, 'same file id at the new location');
  assert(calls.readTags === 0, 'a rename keeps size and mtime, so nothing is re-read');

  const entry = db.prepare(`SELECT file_id, location FROM catalog_entry WHERE catalog='music' AND catalog_id='PID1'`).get() as { file_id: string; location: string };
  assert(entry.file_id === before.id && entry.location === p('New Album/01.mp3'), `listing updated: ${JSON.stringify(entry)}`);

  // A listing that disappears from the catalog is dropped from catalog_entry.
  recordCatalogEntries(db, 'music', [], new Map());
  const left = (db.prepare(`SELECT COUNT(*) AS n FROM catalog_entry`).get() as { n: number }).n;
  assert(left === 0, 'de-listed entries are removed');
  assert(fileByPath(db, p('New Album/01.mp3')), 'the file row itself stays');
}

// --- a catalog move never lands on a path another file holds --------
{
  const db = freshDb();
  write('x/1.mp3', 'AUDIO-X1', 'X1');
  write('x/2.mp3', 'AUDIO-X2', 'X2');
  const s = await scanFiles(db, want('x/1.mp3', 'x/2.mp3'), deps);
  recordCatalogEntries(db, 'music', [{ catalogId: 'P1', path: p('x/1.mp3') }, { catalogId: 'P2', path: p('x/2.mp3') }], s.files);
  // The catalog now claims P1 lives where P2 is.
  assert(applyCatalogMoves(db, 'music', [{ catalogId: 'P1', path: p('x/2.mp3') }]) === 0, 'refused: path already has a file');
  assert(fileByPath(db, p('x/1.mp3')), 'the first file is left alone');
}

// --- a stale row for a long-gone file never blocks a catalog move ----
// Review finding: refusing the move re-pointed the Persistent ID at the stale
// row, the real track's link went unemitted, and the prune deleted it.
{
  const db = freshDb();
  write('gone/01.mp3', 'AUDIO-GONE', 'Gone');
  write('src/01.mp3', 'AUDIO-KEEP', 'Keep');
  const s1 = await scanFiles(db, want('gone/01.mp3', 'src/01.mp3'), deps);
  recordCatalogEntries(db, 'music', [{ catalogId: 'OLD', path: p('gone/01.mp3') }, { catalogId: 'KEEP', path: p('src/01.mp3') }], s1.files);
  rmSync(p('gone/01.mp3'));
  const s2 = await scanFiles(db, want('gone/01.mp3', 'src/01.mp3'), deps);
  recordCatalogEntries(db, 'music', [{ catalogId: 'OLD', path: p('gone/01.mp3') }, { catalogId: 'KEEP', path: p('src/01.mp3') }], s2.files);
  const keepId = s2.files.get(p('src/01.mp3'))!.id;
  // Music.app drops the gone track, and renames KEEP's folder onto the old path.
  renameSync(p('src/01.mp3'), p('gone/01.mp3'));
  assert(applyCatalogMoves(db, 'music', [{ catalogId: 'KEEP', path: p('gone/01.mp3') }]) === 1, 'the move goes ahead over a stale row');
  const s3 = await scanFiles(db, want('gone/01.mp3'), deps);
  assert(s3.files.get(p('gone/01.mp3'))!.id === keepId, 'the moved file keeps its id');
}

// --- a file that couldn't be read is retried once it can be ----------
// Review finding: a refused read (macOS's Music-folder prompt) was cached
// like a corrupt file and never revisited while size and mtime held.
{
  const db = freshDb();
  write('locked.mp3', 'AUDIO-L', 'Locked');
  let refuse = true;
  const gated: FileListDeps = {
    async fingerprint(path) { if (refuse) throw new Error('EPERM'); return deps.fingerprint(path); },
    async readTags(path) { if (refuse) throw new Error('EPERM'); return deps.readTags(path); },
  };
  const first = await scanFiles(db, want('locked.mp3'), gated);
  assert(first.files.get(p('locked.mp3'))!.tags === null, 'nothing read while refused');
  refuse = false;
  const second = await scanFiles(db, want('locked.mp3'), gated);
  const f = second.files.get(p('locked.mp3'))!;
  assert(f.tags?.title === 'Locked' && f.fingerprint, `read once access is granted: ${JSON.stringify(f)}`);
}

rmSync(root, { recursive: true, force: true });
console.log('PASS: file list');
