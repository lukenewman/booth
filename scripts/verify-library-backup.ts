/**
 * Booth's own backups. Load-bearing claims:
 *  - the first run copies every present library file and a database snapshot,
 *    and records what it holds; the second copies nothing;
 *  - a changed file is copied again; a damaged copy is found by a verifying
 *    run and replaced;
 *  - a copy that fails part-way never sits under its final name;
 *  - a destination without room is refused before anything is copied, and one
 *    inside the library is refused outright;
 *  - stopping leaves a run that the next one completes;
 *  - status counts the releases not in the last backup.
 * Temp dirs and an in-memory database only.
 *
 * Run: bun verify scripts/verify-library-backup.ts
 */
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runMigrations } from '../src/lib/server/db/migrate';
import { collate } from '../src/lib/server/library/collate';
import type { FileListDeps } from '../src/lib/server/library/fileList';
import { buildLocalResult } from '../src/lib/server/sources/local/localResult';
import { releaseIdForTags } from '../src/lib/server/sources/local/sync';
import { backupStatus, runLibraryBackup, setDestination, type BackupDeps } from '../src/lib/server/backup/library';

function fail(msg: string): never { console.error(`FAIL: ${msg}`); process.exit(1); }
function assert(cond: unknown, msg: string): asserts cond { if (!cond) fail(msg); }

const root = mkdtempSync(join(tmpdir(), 'booth-backup-'));
const lib = join(root, 'Music');
const dest = join(root, 'Drive');
mkdirSync(dest);
const p = (n: string) => join(lib, n);
const write = (n: string, audio: string, tag = 'T') => { mkdirSync(dirname(p(n)), { recursive: true }); writeFileSync(p(n), `${audio}\n${tag}\n`); };
const audioOf = (path: string) => readFileSync(path, 'utf8').split('\n')[0];
const fpDeps: FileListDeps = {
  async fingerprint(path) { return createHash('md5').update(audioOf(path)).digest('hex'); },
  async readTags() { return { title: 'T', artist: 'Artist', album: 'Album', year: 2020, trackNumber: 1, booth: {} }; },
};

const db = new Database(':memory:');
db.exec('PRAGMA foreign_keys = ON');
runMigrations(db);

write('A/01.mp3', 'AUD1'); write('A/02.mp3', 'AUD2'); write('B/01.mp3', 'AUD3');
const listed = [
  { pid: 'P1', name: 'A/01.mp3', rel: 'relA', pos: 1 },
  { pid: 'P2', name: 'A/02.mp3', rel: 'relA', pos: 2 },
  { pid: 'P3', name: 'B/01.mp3', rel: 'relB', pos: 1 },
];
async function sync() {
  const built = await buildLocalResult(db, {
    catalogs: [{
      id: 'music',
      releases: [{ externalId: 'relA', title: 'Album A', artist: 'Artist', year: 2021 }, { externalId: 'relB', title: 'Album B', artist: 'Artist', year: 2022 }],
      tracks: listed.map((t) => ({ catalogId: t.pid, path: p(t.name), track: { title: t.name, artist: 'Artist', album: t.rel, position: String(t.pos), releaseExternalId: t.rel, facets: {} } })),
    }],
    boothFiles: [],
    groupIdFor: releaseIdForTags,
  }, fpDeps);
  collate(db, 'local', { tracks: built.tracks, releases: built.releases });
}
await sync();

let free = 10_000_000;
let failCopyOf: string | null = null;
const deps: BackupDeps = {
  fingerprint: fpDeps.fingerprint,
  snapshotDb: (to) => db.exec(`VACUUM INTO '${to.replaceAll("'", "''")}'`),
  freeBytes: () => free,
  async copyFile(from, to) {
    if (failCopyOf && from === failCopyOf) {
      writeFileSync(to, 'partial');
      throw new Error('disk ejected');
    }
    await copyFile(from, to);
  },
};
const copyOf = (n: string) => join(dest, 'Booth Backup', 'files', p(n).slice(1));

// --- destination checks ------------------------------------------------------
{
  let refused = false;
  try { setDestination(db, join(lib, 'A'), { libraryRoots: [lib] }); } catch { refused = true; }
  assert(refused, 'a destination inside the library is refused');
  const d = setDestination(db, dest, { libraryRoots: [lib] });
  assert(d.path === dest && d.sameDisk === true, `temp dirs share a disk, and that is flagged, got ${JSON.stringify(d)}`);
  const s = backupStatus(db);
  assert(s.lastBackupAt === null && s.releasesNotBackedUp === 2, `nothing backed up yet: both releases outstanding, got ${JSON.stringify(s)}`);
  console.log('ok destination');
}

// --- not enough room ---------------------------------------------------------------
{
  free = 3;
  const r = await runLibraryBackup(db, deps);
  assert(r.state === 'failed' && /space/i.test(r.error ?? ''), `refused for space, got ${JSON.stringify(r)}`);
  assert(!existsSync(copyOf('A/01.mp3')), 'nothing copied when refused');
  free = 10_000_000;
  console.log('ok space check');
}

// --- first and second run ---------------------------------------------------------
{
  const r = await runLibraryBackup(db, deps);
  assert(r.state === 'done' && r.filesCopied === 3 && r.filesSkipped === 0, `first run copies all three, got ${JSON.stringify(r)}`);
  assert(readFileSync(copyOf('A/01.mp3'), 'utf8') === readFileSync(p('A/01.mp3'), 'utf8'), 'the copy is the file');
  const snaps = readdirSync(join(dest, 'Booth Backup', 'database'));
  assert(snaps.length === 1 && snaps[0].endsWith('.db'), `a database snapshot, got ${snaps}`);
  const snap = new Database(join(dest, 'Booth Backup', 'database', snaps[0]), { readonly: true });
  assert((snap.prepare(`SELECT COUNT(*) AS n FROM track`).get() as { n: number }).n === 3, 'the snapshot holds the library');
  snap.close();
  const s = backupStatus(db);
  assert(s.lastBackupAt && s.daysSince === 0 && s.releasesNotBackedUp === 0 && s.filesToCopy === 0, `all held, got ${JSON.stringify(s)}`);
  const again = await runLibraryBackup(db, deps);
  assert(again.state === 'done' && again.filesCopied === 0 && again.filesSkipped === 3, `second run copies nothing, got ${JSON.stringify(again)}`);
  console.log('ok first and second run');
}

// --- a changed file ------------------------------------------------------------------
{
  write('B/01.mp3', 'AUD3', 'retagged and longer');
  await sync();
  assert(backupStatus(db).releasesNotBackedUp === 1, 'the changed file\'s release is outstanding');
  const r = await runLibraryBackup(db, deps);
  assert(r.filesCopied === 1 && readFileSync(copyOf('B/01.mp3'), 'utf8').includes('retagged'), `the changed file is copied again, got ${JSON.stringify(r)}`);
  console.log('ok changed file');
}

// --- a damaged copy -------------------------------------------------------------------
{
  const st = statSync(copyOf('A/02.mp3'));
  writeFileSync(copyOf('A/02.mp3'), 'XXXX\nT\n');
  utimesSync(copyOf('A/02.mp3'), st.atime, st.mtime);
  const quick = await runLibraryBackup(db, deps);
  assert(quick.filesCopied === 0, 'an ordinary run trusts what it recorded');
  const verifying = await runLibraryBackup(db, deps, { verify: true });
  assert(verifying.filesCopied === 1 && audioOf(copyOf('A/02.mp3')) === 'AUD2', `a verifying run finds and replaces the damaged copy, got ${JSON.stringify(verifying)}`);
  console.log('ok damaged copy');
}

// --- a copy that fails part-way ----------------------------------------------------------
{
  write('A/01.mp3', 'AUD1', 'changed again');
  await sync();
  failCopyOf = p('A/01.mp3');
  const r = await runLibraryBackup(db, deps);
  assert(r.failed.length === 1 && r.state === 'done', `the failure is reported, the rest carries on, got ${JSON.stringify(r)}`);
  assert(!readFileSync(copyOf('A/01.mp3'), 'utf8').includes('partial'), 'the final name still holds the last good copy');
  assert(!readdirSync(dirname(copyOf('A/01.mp3'))).some((n) => n.includes('partial') || n.endsWith('.part')), 'no partial file left behind');
  assert(backupStatus(db).releasesNotBackedUp === 1, 'its release is still outstanding');
  failCopyOf = null;
  console.log('ok failed copy');
}

// --- stop and resume -----------------------------------------------------------------------
{
  write('A/02.mp3', 'AUD2', 'changed'); write('B/01.mp3', 'AUD3', 'changed too');
  await sync();
  let n = 0;
  const stopped = await runLibraryBackup(db, deps, { shouldStop: () => n++ >= 1 });
  assert(stopped.state === 'stopped' && stopped.filesCopied === 1, `stopped after one, got ${JSON.stringify(stopped)}`);
  const resumed = await runLibraryBackup(db, deps);
  assert(resumed.state === 'done' && resumed.filesCopied === 2, `the next run finishes the rest, got ${JSON.stringify(resumed)}`);
  assert(backupStatus(db).releasesNotBackedUp === 0, 'all held again');
  console.log('ok stop and resume');
}

console.log('PASS verify-library-backup');
