/**
 * probe-takeover.ts — the sample takeover on a copy of the real library.
 *
 * Copies the real database, takes over a suggested sample into a scratch
 * Booth folder with the real tag writer and fingerprints, and checks: every
 * copy's tags rebuild what Booth knows; a sync afterwards keeps every track,
 * star, note and playlist entry and raises nothing new; undoing everything
 * gives back the database as it was; the originals are byte-for-byte untouched.
 *
 * READ-ONLY against the library and the real database: only the scratch copy
 * and the scratch folder are written.
 *
 * Run: bun verify scripts/probe-takeover.ts [--seed 1] [--size 10]
 */
import { mkdirSync, mkdtempSync, rmSync, statSync, statfsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (name: string, fallback: number) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? Number(process.argv[i + 1]) : fallback; };
const scratch = mkdtempSync(join(tmpdir(), 'booth-takeover-probe-'));
const copy = join(scratch, 'booth.db');
const real = join(homedir(), '.booth', 'booth.db');
const proc = Bun.spawnSync(['sqlite3', real, `.backup '${copy}'`]);
if (proc.exitCode !== 0) throw new Error(`backup failed: ${proc.stderr.toString()}`);
const boothRoot = join(scratch, 'Booth');
process.env.BOOTH_DB_PATH = copy;
process.env.BOOTH_INBOX_PATH = join(scratch, 'inbox');
process.env.BOOTH_LIBRARY_PATH = boothRoot;
process.env.REKORDBOX_XML_PATH = '';
mkdirSync(process.env.BOOTH_INBOX_PATH);

const { getDb } = await import('../src/lib/server/db');
const { collate } = await import('../src/lib/server/library/collate');
const { refreshFindings } = await import('../src/lib/server/library/findings');
const { syncITunesLibrary } = await import('../src/lib/server/sources/local/sync');
const { audioFingerprint } = await import('../src/lib/server/library/fingerprint');
const { readTags } = await import('../src/lib/server/library/tags');
const { writeTags } = await import('../src/lib/server/library/tag_writer');
const { createTakeoverRun, runTakeover } = await import('../src/lib/server/takeover/engine');
const { rebuildCheck, undoRelease } = await import('../src/lib/server/takeover/undo');
const { suggestSample } = await import('../src/lib/server/takeover/sample');

const db = getDb();
const recordingsRoot = join(homedir(), '.booth', 'recordings');
const deps = {
  writeTags, readTags, fingerprint: audioFingerprint,
  freeBytes: (dir: string) => { const s = statfsSync(dir); return Number(s.bavail) * Number(s.bsize); },
};

async function sync(label: string) {
  const r = await syncITunesLibrary();
  const c = collate(db, 'local', r, { recordingsRoot });
  const f = refreshFindings(db, null, r.fileIds ?? [], { leaveAlone: r.offlineFileIds });
  console.log(`${label}: ${c.tracksDeleted ?? 0} tracks deleted, findings new ${f.new} cleared ${f.cleared} open ${f.open}`);
  return f;
}
const q = <T>(sql: string, ...a: unknown[]) => db.prepare(sql).all(...a) as T[];
const snapshot = () => ({
  trackIds: q(`SELECT id FROM track ORDER BY id`),
  annotations: q(`SELECT id, starred_at, note, tapped_bpm FROM track WHERE starred_at IS NOT NULL OR note IS NOT NULL OR tapped_bpm IS NOT NULL ORDER BY id`),
  playlistTracks: q(`SELECT id, track_id FROM playlist_track ORDER BY id`),
  localLinks: q(`SELECT entity_id, external_id FROM source_link WHERE source = 'local' ORDER BY entity_id`),
  // Which findings, and their state: a takeover re-keys a finding onto the copies' ids, by design.
  findings: q(`SELECT id, kind, state FROM finding WHERE kind <> 'takeover' ORDER BY id`),
  findingKeys: q(`SELECT id, subject_key FROM finding WHERE kind <> 'takeover' ORDER BY id`),
});
let problems = 0;
function same(label: string, a: unknown[], b: unknown[]) {
  const as = new Set(a.map((x) => JSON.stringify(x))), bs = new Set(b.map((x) => JSON.stringify(x)));
  const gone = [...as].filter((x) => !bs.has(x)), added = [...bs].filter((x) => !as.has(x));
  if (gone.length || added.length) { problems++; console.log(`✗ ${label}: ${gone.length} gone, ${added.length} new`); for (const g of gone.slice(0, 3)) console.log(`   - ${g}`); for (const n of added.slice(0, 3)) console.log(`   + ${n}`); }
  else console.log(`✓ ${label} (${a.length})`);
}

await sync('baseline sync');
const base = snapshot();
const sample = suggestSample(db, { seed: arg('seed', 1), size: arg('size', 10) });
console.log(`\nsample (${sample.length}):`);
for (const s of sample) console.log(`  ${s.artist} — ${s.title} (${s.files} files, ${(s.bytes / 1e6).toFixed(0)} MB)${s.reasons.length ? ` · ${s.reasons.join('; ')}` : ''}`);
const ids = sample.map((s) => s.releaseId);
const originalFiles = q<{ path: string }>(`SELECT f.path FROM track t JOIN source_link sl ON sl.entity_id = t.id AND sl.source = 'local' JOIN audio_file f ON f.id = sl.external_id WHERE t.release_id IN (${ids.map(() => '?').join(',')})`, ...ids).map((r) => r.path);
const stamp = async () => Promise.all(originalFiles.map(async (p) => { const st = statSync(p); const h = new Bun.CryptoHasher('sha256'); h.update(await Bun.file(p).arrayBuffer()); return `${p}:${st.size}:${st.mtimeMs}:${h.digest('hex')}`; }));
const before = await stamp();

const t0 = Date.now();
const run = await runTakeover(db, deps, createTakeoverRun(db, ids, { sample: true }), { root: boothRoot });
console.log(`\ntakeover ${((Date.now() - t0) / 1000).toFixed(0)}s: ${JSON.stringify(run)}`);
for (const f of q<{ release_id: string; error: string }>(`SELECT release_id, error FROM takeover_release WHERE state = 'failed'`)) console.log(`  failed ${f.release_id}: ${f.error}`);
const done = q<{ release_id: string }>(`SELECT release_id FROM takeover_release WHERE state = 'done'`).map((r) => r.release_id);
for (const r of done) {
  const c = await rebuildCheck(db, r, deps);
  if (!c.matches) { problems++; console.log(`✗ rebuild ${r}: ${JSON.stringify(c.differences.slice(0, 3))}`); }
}
console.log(`rebuild check: ${done.length} releases`);

const after = snapshot();
await sync('sync after takeover');
const synced = snapshot();
same('tracks after takeover + sync', base.trackIds, synced.trackIds);
same('stars, notes, taps', base.annotations, synced.annotations);
same('playlist entries', base.playlistTracks, synced.playlistTracks);
same('the takeover\'s links survive a sync', after.localLinks, synced.localLinks);
same('findings and their states', base.findings, synced.findings);

for (const r of done) await undoRelease(db, deps, r);
await sync('sync after undo');
const undone = snapshot();
same('undo: tracks', base.trackIds, undone.trackIds);
same('undo: links back to the originals', base.localLinks, undone.localLinks);
same('undo: stars, notes, taps', base.annotations, undone.annotations);
same('undo: playlist entries', base.playlistTracks, undone.playlistTracks);
same('undo: findings exactly as they were', base.findingKeys, undone.findingKeys);
same('undo: finding states', base.findings, undone.findings);
same('originals byte-for-byte', before, await stamp());
console.log(problems ? `\n${problems} problem(s)` : '\nall clear');
db.close();
rmSync(scratch, { recursive: true, force: true }); // the scratch database and copies only
process.exit(problems ? 1 : 0);
