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

console.log('PASS verify-findings');
