/**
 * Folder sources: point Booth at a folder. Load-bearing claims:
 *  - a file both Music.app and a folder reach is one track, whatever Unicode
 *    spelling each uses for its name, and raises no duplicate;
 *  - a file only the folder reaches becomes a track from its own tags;
 *  - an unreachable folder is offline: its tracks stay, nothing is raised,
 *    and it comes back to normal when the folder returns;
 *  - removing a folder shows, then removes, only the tracks it alone reached;
 *  - a different file with the same audio is still a duplicate.
 * Temp dirs and an in-memory database only.
 *
 * Run: bun verify scripts/verify-folder-sources.ts
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
import { refreshFindings, listOpenFindings } from '../src/lib/server/library/findings';
import { addFolderSource, folderRemovalImpact, listFolderSources, removeFolderSource } from '../src/lib/server/library/folders';
import { createPlaylist, addTrack } from '../src/lib/server/library/playlists';
import { buildLocalResult } from '../src/lib/server/sources/local/localResult';
import { listAudioFiles } from '../src/lib/server/sources/local/ingest';
import { releaseIdForTags } from '../src/lib/server/sources/local/sync';

function fail(msg: string): never { console.error(`FAIL: ${msg}`); process.exit(1); }
function assert(cond: unknown, msg: string): asserts cond { if (!cond) fail(msg); }

const root = mkdtempSync(join(tmpdir(), 'booth-folders-'));
const p = (n: string) => join(root, n);
/** Line 1 the audio, line 2 the title tag, line 3 the track number tag. */
const write = (n: string, audio: string, title: string, no = 1) => { mkdirSync(dirname(p(n)), { recursive: true }); writeFileSync(p(n), `${audio}\n${title}\n${no}\n`); };
const deps: FileListDeps = {
  async fingerprint(path) { return createHash('md5').update(readFileSync(path, 'utf8').split('\n')[0]).digest('hex'); },
  async readTags(path): Promise<FileTags> {
    const [, title, no] = readFileSync(path, 'utf8').split('\n');
    return { title, artist: 'Folder Artist', album: 'Folder Album', year: 2022, trackNumber: Number(no), booth: {} };
  },
};

const db = new Database(':memory:');
db.exec('PRAGMA foreign_keys = ON');
runMigrations(db);

// Music.app lists two files under Music/, one with a decomposed name. The
// folder source is Music/ itself plus a loose file Music.app doesn't list.
const CAFE_NFD = 'Café';
write('Music/A/01 One.mp3', 'AUD1', 'One (tag)');
write(`Music/A/02 ${CAFE_NFD}.mp3`, 'AUD2', 'Café (tag)');
write('Music/Loose/new.mp3', 'AUD3', 'New one');
const listed = [
  { pid: 'P1', path: p('Music/A/01 One.mp3'), pos: 1, title: 'One' },
  // Music.app's spelling: composed, while the disk has it decomposed.
  { pid: 'P2', path: p(`Music/A/02 ${CAFE_NFD}.mp3`).normalize('NFC'), pos: 2, title: 'Café' },
];

/** A local sync: Music.app's listing plus every folder source, as sync.ts builds it. */
async function sync(opts: { offline?: Set<string> } = {}) {
  const folders = listFolderSources(db).map((f) => {
    const online = !opts.offline?.has(f.path);
    return { root: f.path, online, files: online ? listAudioFiles(f.path) : [] };
  });
  const built = await buildLocalResult(db, {
    catalogs: [{
      id: 'music',
      releases: [{ externalId: 'rel', title: 'Album', artist: 'Artist', year: 2021 }],
      tracks: listed.map((t) => ({ catalogId: t.pid, path: t.path, track: { title: t.title, artist: 'Artist', album: 'Album', position: String(t.pos), releaseExternalId: 'rel', facets: {} } })),
    }],
    boothFiles: [],
    folders,
    groupIdFor: releaseIdForTags,
  }, deps);
  const c = collate(db, 'local', { tracks: built.tracks, releases: built.releases });
  const f = refreshFindings(db, 'r', built.fileIds, { leaveAlone: built.offlineFileIds });
  return { built, collate: c, findings: f };
}
const titles = () => (db.prepare(`SELECT title FROM track ORDER BY title`).all() as { title: string }[]).map((r) => r.title).join(' | ');

// --- add a folder ----------------------------------------------------------
{
  await sync();
  assert(titles() === 'Café | One', `Music.app alone: two tracks, got ${titles()}`);
  let refused = false;
  try { addFolderSource(db, p('nowhere')); } catch { refused = true; }
  assert(refused, 'a folder that does not exist is refused');
  addFolderSource(db, p('Music') + '/');
  assert(listFolderSources(db).length === 1 && listFolderSources(db)[0].path === p('Music'), 'stored without a trailing slash');
  const s = await sync();
  assert(titles() === 'Café | New one | One', `overlap is one track each; the loose file is new, got ${titles()}`);
  assert(s.findings.open === 0, `no duplicate for a file both reach, got ${JSON.stringify(listOpenFindings(db))}`);
  assert((db.prepare(`SELECT COUNT(*) AS n FROM audio_file`).get() as { n: number }).n === 3, 'one file row per file');
  const again = await sync();
  assert(again.collate.tracksDeleted === 0 && again.findings.new === 0 && titles() === 'Café | New one | One', 'a second sync changes nothing');
  console.log('ok overlap and folder-only file');
}

// --- offline folder ----------------------------------------------------------
{
  const loose = db.prepare(`SELECT id FROM track WHERE title = 'New one'`).get() as { id: string };
  db.prepare(`UPDATE track SET starred_at = '2026-01-01' WHERE id = ?`).run(loose.id);
  const s = await sync({ offline: new Set([p('Music')]) });
  assert(titles() === 'Café | New one | One' && s.collate.tracksDeleted === 0, `offline folder keeps its tracks, got ${titles()}`);
  assert(s.findings.new === 0, `offline folder raises nothing, got ${JSON.stringify(s.findings)}`);
  assert(db.prepare(`SELECT starred_at FROM track WHERE id = ?`).get(loose.id), 'and its star');
  await sync();
  assert(titles() === 'Café | New one | One', 'back online: unchanged');
  console.log('ok offline folder');
}

// --- a different file with the same audio is a duplicate ---------------------
{
  write('Music/Loose/one again.mp3', 'AUD1', 'One again', 2);
  const s = await sync();
  assert(s.findings.new === 1 && listOpenFindings(db)[0].kind === 'duplicate', `same audio, different file: a duplicate, got ${JSON.stringify(s.findings)}`);
  console.log('ok duplicate across folder and Music.app');
}

// --- remove the folder ---------------------------------------------------------
{
  const loose = db.prepare(`SELECT id FROM track WHERE title = 'New one'`).get() as { id: string };
  const pl = createPlaylist(db, 'Warmup');
  addTrack(db, pl.id, loose.id);
  const folderId = listFolderSources(db)[0].id;
  const impact = folderRemovalImpact(db, folderId);
  assert(impact.tracks === 2 && impact.starred === 1 && impact.inPlaylists === 1, `impact counts only folder-only tracks, got ${JSON.stringify(impact)}`);
  removeFolderSource(db, folderId);
  await sync();
  assert(titles() === 'Café | One', `removing the folder removes only its own tracks, got ${titles()}`);
  console.log('ok remove folder');
}

// --- review fixes (2026-11-03): offline and odd folders -------------------------
{
  const { settleFinding } = await import('../src/lib/server/library/findings');
  const { rmSync } = await import('node:fs');
  const ids = () => new Set((db.prepare(`SELECT id FROM track`).all() as { id: string }[]).map((r) => r.id));

  // #1: a folder whose name has an emoji survives going offline, and its removal preview counts its tracks.
  const drive = p('🎧 Drive');
  write('🎧 Drive/x.mp3', 'AUDX', 'Emoji drive song', 1);
  const f1 = addFolderSource(db, drive);
  await sync();
  assert(titles().includes('Emoji drive song'), 'scenario: emoji-folder track exists');
  assert(folderRemovalImpact(db, f1.id).tracks === 1, `removal preview counts it, got ${JSON.stringify(folderRemovalImpact(db, f1.id))}`);
  const off = await sync({ offline: new Set([drive]) });
  assert(off.collate.tracksDeleted === 0 && titles().includes('Emoji drive song'), 'offline emoji folder keeps its track');
  console.log('ok emoji folder');

  // #2: a file deleted while the folder was online doesn't come back when it goes offline.
  write('🎧 Drive/gone.mp3', 'AUDG', 'Deleted later', 2);
  await sync();
  rmSync(p('🎧 Drive/gone.mp3'));
  await sync();
  assert(!titles().includes('Deleted later'), 'scenario: pruned while online');
  await sync({ offline: new Set([drive]) });
  assert(!titles().includes('Deleted later'), 'a deleted file is not resurrected by going offline');
  console.log('ok offline does not resurrect');

  // #4: an open finding involving offline files stays open, not cleared and re-raised.
  write('🎧 Drive/x copy.mp3', 'AUDX', 'Emoji copy', 3);
  let s = await sync();
  assert(s.findings.new === 1, `scenario: a duplicate on the drive, got ${JSON.stringify(s.findings)}`);
  s = await sync({ offline: new Set([drive]) });
  assert(s.findings.cleared === 0 && s.findings.new === 0, `offline leaves it alone, got ${JSON.stringify(s.findings)}`);
  s = await sync();
  assert(s.findings.new === 0, `and it isn't raised again on return, got ${JSON.stringify(s.findings)}`);

  // #3: a keep-one decision survives the kept copy's drive going offline.
  const dup = listOpenFindings(db).find((x) => x.kind === 'duplicate' && x.files.some((y) => y.path.endsWith('x copy.mp3')))!;
  settleFinding(db, dup.id, { type: 'keep_one', fileId: dup.files.find((y) => y.path.endsWith('/x.mp3'))!.fileId });
  await sync();
  await sync({ offline: new Set([drive]) });
  assert(!titles().includes('Emoji copy'), 'the left-out copy is not restored while the kept one is offline');
  await sync();
  assert(!titles().includes('Emoji copy'), 'nor after it returns');
  console.log('ok offline keeps decisions and findings');

  // #5: a folder that is readable but suddenly empty keeps its tracks (an empty mount point looks like this).
  const before = ids();
  rmSync(drive, { recursive: true });
  mkdirSync(drive);
  const empty = await sync();
  assert(empty.collate.tracksDeleted === 0 && [...before].every((id) => ids().has(id)), 'an emptied folder prunes nothing');
  assert(empty.built.folders.find((f) => f.root === drive)?.online === false, 'it is reported as offline');
  console.log('ok empty folder');

  // #6: an unreadable subfolder doesn't fail the walk; home and Booth's own places are refused.
  const { chmodSync } = await import('node:fs');
  write('Music/Locked/secret.mp3', 'AUDL', 'Locked', 9);
  chmodSync(p('Music/Locked'), 0o000);
  let walked: string[] = [];
  try { walked = listAudioFiles(p('Music')); } finally { chmodSync(p('Music/Locked'), 0o755); }
  assert(walked.some((x) => x.endsWith('01 One.mp3')), 'the rest of the folder is still walked');
  const { homedir } = await import('node:os');
  for (const bad of ['/', homedir()]) {
    let refused = false;
    try { addFolderSource(db, bad); } catch { refused = true; }
    assert(refused, `${bad} is refused`);
  }
  console.log('ok walk errors and refused folders');
}

console.log('PASS verify-folder-sources');
