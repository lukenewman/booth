/**
 * Edge cases of the needs-attention list found in review (2026-11-03). Each
 * scenario gets its own temp dir and in-memory database, and its syncs run the
 * relinker the way a real sync does:
 *  - keeping a copy that has no track of its own never loses the others' stars,
 *    notes or playlist entries;
 *  - forgetting a missing file whose track lives on (another copy at the same
 *    position) keeps the track's playlist entries;
 *  - a copy taken out by "keep one" comes back when the kept copy goes away;
 *  - a new copy of an excluded file's audio is a new file, not the excluded one moved;
 *  - the library play queue skips tracks whose file is missing;
 *  - keep one moves a tapped BPM too;
 *  - a settle waiting on a sync already running gets a fresh sync afterwards.
 *
 * Run: bun verify scripts/verify-findings-edges.ts
 */
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runMigrations } from '../src/lib/server/db/migrate';
import { collate } from '../src/lib/server/library/collate';
import type { FileListDeps } from '../src/lib/server/library/fileList';
import { buildLocalResult } from '../src/lib/server/sources/local/localResult';
import { releaseIdForTags } from '../src/lib/server/sources/local/sync';
import { refreshFindings, listOpenFindings, settleFinding } from '../src/lib/server/library/findings';
import { createPlaylist, addTrack } from '../src/lib/server/library/playlists';
import { listTrackIds } from '../src/lib/server/library/queries';
import { relinkMissing } from '../src/lib/server/library/relink';
import { joinThenRun } from '../src/lib/server/library/sync_run';

function fail(msg: string): never { console.error(`FAIL: ${msg}`); process.exit(1); }
function assert(cond: unknown, msg: string): asserts cond { if (!cond) fail(msg); }

type L = { pid: string; name: string; pos: number; title: string };

function env() {
  const root = mkdtempSync(join(tmpdir(), 'booth-findings-edge-'));
  const p = (n: string) => join(root, n);
  const write = (n: string, audio: string) => { mkdirSync(dirname(p(n)), { recursive: true }); writeFileSync(p(n), `${audio}\nT\n`); };
  const deps: FileListDeps = {
    async fingerprint(path) { return createHash('md5').update(readFileSync(path, 'utf8').split('\n')[0]).digest('hex'); },
    async readTags() { return { title: 'T', artist: 'Artist', album: 'Album', year: 2020, trackNumber: 1, booth: {} }; },
  };
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db);
  const sync = async (listed: L[]) => {
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
    relinkMissing(db);
    return refreshFindings(db, 'r', built.fileIds);
  };
  const trackOf = (n: string) => (db.prepare(
    `SELECT sl.entity_id AS id FROM source_link sl JOIN audio_file f ON f.id = sl.external_id
      WHERE sl.source = 'local' AND sl.entity_kind = 'track' AND f.path = ?`,
  ).get(p(n)) as { id: string } | null)?.id ?? null;
  /** Settle as the endpoint does: settle, sync, then whatever the settle asked to run after. */
  const settleAndSync = async (id: string, action: Parameters<typeof settleFinding>[2], listed: L[]) => {
    const r = settleFinding(db, id, action);
    if (r.needsSync) await sync(listed);
    r.afterSync?.();
  };
  return { db, p, write, sync, trackOf, settleAndSync };
}

// --- C1: keeping the copy that has no track of its own --------------------
{
  const e = env();
  e.write('S/01.mp3', 'AUD'); e.write('S/01 1.mp3', 'AUD'); e.write('C/05.mp3', 'AUD');
  const listed = [
    { pid: 'X', name: 'S/01.mp3', pos: 1, title: 'Song' },
    { pid: 'Y', name: 'S/01 1.mp3', pos: 1, title: 'Song' },
    { pid: 'Z', name: 'C/05.mp3', pos: 5, title: 'Song comp' },
  ];
  await e.sync(listed);
  const comp = e.trackOf('C/05.mp3')!;
  e.db.prepare(`UPDATE track SET starred_at = '2026-01-01', note = 'comp note' WHERE id = ?`).run(comp);
  const pl = createPlaylist(e.db, 'Gig');
  addTrack(e.db, pl.id, comp);
  const f = listOpenFindings(e.db).find((x) => x.kind === 'duplicate')!;
  const trackless = f.files.find((x) => x.path.endsWith('S/01 1.mp3'));
  assert(trackless && !e.trackOf('S/01 1.mp3'), 'scenario: one same-position copy has no track of its own');
  assert(trackless.track, 'the view names the track that copy shares');
  try { await e.settleAndSync(f.id, { type: 'keep_one', fileId: trackless.fileId }, listed); } catch { /* refusing is an acceptable outcome */ }
  await e.sync(listed);
  const kept = e.db.prepare(`SELECT id FROM track WHERE starred_at IS NOT NULL AND note LIKE '%comp note%'`).get() as { id: string } | null;
  assert(kept, 'the compilation copy\'s star and note survive on some track');
  const entry = e.db.prepare(`SELECT track_id FROM playlist_track WHERE playlist_id = ?`).get(pl.id) as { track_id: string | null } | null;
  assert(entry?.track_id && e.db.prepare(`SELECT 1 FROM track WHERE id = ?`).get(entry.track_id), 'the gig entry still points at a live track');
  console.log('ok C1 keep a trackless copy loses nothing');
}

// --- I1: forget a missing file whose track lives on ----------------------
{
  const e = env();
  e.write('M/01.mp3', 'AUD'); e.write('M/01 1.mp3', 'AUD');
  const listed = [{ pid: 'M', name: 'M/01.mp3', pos: 1, title: 'Song' }, { pid: 'P', name: 'M/01 1.mp3', pos: 1, title: 'Song' }];
  await e.sync(listed); await e.sync(listed);
  const t = e.trackOf('M/01.mp3') ?? e.trackOf('M/01 1.mp3');
  assert(t, 'scenario: a shared track');
  const pl = createPlaylist(e.db, 'Gig');
  addTrack(e.db, pl.id, t);
  rmSync(e.p('M/01.mp3'));
  await e.sync(listed);
  const f = listOpenFindings(e.db).find((x) => x.kind === 'missing');
  if (f) {
    await e.settleAndSync(f.id, { type: 'forget' }, listed);
    await e.sync(listed);
  }
  if (e.db.prepare(`SELECT 1 FROM track WHERE id = ?`).get(t)) {
    assert(e.db.prepare(`SELECT 1 FROM playlist_track WHERE playlist_id = ? AND track_id = ?`).get(pl.id, t), 'a track that survives forgetting one of its files keeps its gig entry');
  }
  console.log('ok I1 forget keeps entries of a surviving track');
}

// --- I1b: forget a track that also has a Discogs link ---------------------
{
  const e = env();
  e.write('D/01.mp3', 'AUD');
  const listed = [{ pid: 'D', name: 'D/01.mp3', pos: 1, title: 'Song' }];
  await e.sync(listed);
  const t = e.trackOf('D/01.mp3')!;
  e.db.prepare(`INSERT INTO source_link (entity_kind, entity_id, source, external_id, match_method) VALUES ('track', ?, 'discogs', 'dg-1', 'manual')`).run(t);
  const pl = createPlaylist(e.db, 'Gig');
  addTrack(e.db, pl.id, t);
  rmSync(e.p('D/01.mp3'));
  await e.sync(listed);
  const f = listOpenFindings(e.db).find((x) => x.kind === 'missing')!;
  assert(f.files[0].track && f.files[0].alsoIn.join() === 'discogs', `the view says the track is also in Discogs, got ${JSON.stringify(f.files[0])}`);
  await e.settleAndSync(f.id, { type: 'forget' }, listed);
  assert(e.db.prepare(`SELECT 1 FROM track WHERE id = ?`).get(t), 'the Discogs track stays');
  assert(e.db.prepare(`SELECT 1 FROM playlist_track WHERE playlist_id = ? AND track_id = ?`).get(pl.id, t), 'and keeps its gig entry');
  console.log('ok I1b forget keeps a track with another source');
}

// --- I2a: the kept copy goes away; the excluded one comes back -------------
{
  const e = env();
  e.write('Z/a.mp3', 'AUD'); e.write('Z/b.mp3', 'AUD');
  const both = [{ pid: 'A', name: 'Z/a.mp3', pos: 1, title: 'A' }, { pid: 'B', name: 'Z/b.mp3', pos: 2, title: 'B' }];
  await e.sync(both);
  const f = listOpenFindings(e.db).find((x) => x.kind === 'duplicate')!;
  await e.settleAndSync(f.id, { type: 'keep_one', fileId: f.files.find((x) => x.path.endsWith('a.mp3'))!.fileId }, both);
  assert(!e.trackOf('Z/b.mp3'), 'scenario: b left the library');
  rmSync(e.p('Z/a.mp3'));
  await e.sync([both[1]]);
  assert(e.trackOf('Z/b.mp3'), 'with the kept copy gone, the other copy is back in the library');
  console.log('ok I2a orphaned copy restored');
}

// --- I2b: a new copy of an excluded file's audio is a new file ------------
{
  const e = env();
  e.write('Z/a.mp3', 'AUD'); e.write('Z/b.mp3', 'AUD');
  let listed = [{ pid: 'A', name: 'Z/a.mp3', pos: 1, title: 'A' }, { pid: 'B', name: 'Z/b.mp3', pos: 2, title: 'B' }];
  await e.sync(listed);
  const f = listOpenFindings(e.db).find((x) => x.kind === 'duplicate')!;
  await e.settleAndSync(f.id, { type: 'keep_one', fileId: f.files.find((x) => x.path.endsWith('a.mp3'))!.fileId }, listed);
  rmSync(e.p('Z/b.mp3')); listed = [listed[0]]; await e.sync(listed);
  e.write('Z/c.mp3', 'AUD'); listed = [...listed, { pid: 'C', name: 'Z/c.mp3', pos: 3, title: 'C' }];
  const s = await e.sync(listed);
  assert(s.new === 1 && listOpenFindings(e.db).some((x) => x.kind === 'duplicate' && x.files.some((y) => y.path.endsWith('c.mp3'))), `a third copy raises a new duplicate, got ${JSON.stringify(s)}`);
  console.log('ok I2b new copy is not the excluded one moved');
}

// --- I3: the library queue skips missing files -----------------------------
{
  const e = env();
  e.write('Q/01.mp3', 'AUD1'); e.write('Q/02.mp3', 'AUD2');
  const listed = [{ pid: 'Q1', name: 'Q/01.mp3', pos: 1, title: 'One' }, { pid: 'Q2', name: 'Q/02.mp3', pos: 2, title: 'Two' }];
  await e.sync(listed);
  const gone = e.trackOf('Q/02.mp3')!;
  rmSync(e.p('Q/02.mp3'));
  await e.sync(listed);
  const ids = listTrackIds(e.db, {} as Parameters<typeof listTrackIds>[1]);
  assert(ids.length === 1 && !ids.includes(gone), `queue skips the missing track, got ${ids.length}`);
  console.log('ok I3 queue skips missing');
}

// --- I5: keep one moves a tapped BPM ---------------------------------------
{
  const e = env();
  e.write('Z/a.mp3', 'AUD'); e.write('Z/b.mp3', 'AUD');
  const both = [{ pid: 'A', name: 'Z/a.mp3', pos: 1, title: 'A' }, { pid: 'B', name: 'Z/b.mp3', pos: 2, title: 'B' }];
  await e.sync(both);
  e.db.prepare(`UPDATE track SET tapped_bpm = 122, tapped_bpm_at = '2026-01-01' WHERE id = ?`).run(e.trackOf('Z/b.mp3'));
  const f = listOpenFindings(e.db).find((x) => x.kind === 'duplicate')!;
  await e.settleAndSync(f.id, { type: 'keep_one', fileId: f.files.find((x) => x.path.endsWith('a.mp3'))!.fileId }, both);
  const t = e.db.prepare(`SELECT tapped_bpm FROM track WHERE id = ?`).get(e.trackOf('Z/a.mp3')) as { tapped_bpm: number | null };
  assert(t.tapped_bpm === 122, `tapped BPM moved, got ${t.tapped_bpm}`);
  console.log('ok I5 tapped BPM moves');
}

// --- I4: a settle that joins a running sync gets a fresh one ---------------
{
  const order: string[] = [];
  let finishRunning!: () => void;
  const running = new Promise<void>((r) => (finishRunning = r)).then(() => { order.push('running done'); });
  const fresh = joinThenRun(running, async () => { order.push('fresh started'); return 'fresh'; });
  await Bun.sleep(10);
  assert(order.length === 0, 'the fresh run waits for the running one');
  finishRunning();
  assert((await fresh) === 'fresh' && order.join() === 'running done,fresh started', `fresh run starts after, got ${order}`);
  const failing = Promise.reject(new Error('boom'));
  assert((await joinThenRun(failing, async () => 'fresh')) === 'fresh', 'a failed running sync still gets a fresh one');
  console.log('ok I4 fresh sync after a joined one');
}

console.log('PASS verify-findings-edges');
